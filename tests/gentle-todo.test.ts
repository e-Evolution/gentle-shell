import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { SessionManager, type BeforeAgentStartEventResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import gentleTodo, { todoCollapseKey, todoEnabled } from "../extensions/gentle-todo.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

// The Gentle Todo extension: the `todo` tool, the card above the editor,
// the cache-stable snapshots, and the staleness signal, driven by fakes.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Registered {
	renderShell?: string;
	execute(toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	renderCall(args: unknown, theme: unknown): { render(width: number): string[] };
	renderResult(result: unknown, options: { expanded: boolean }, theme: unknown): { render(width: number): string[] };
}

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	strikethrough(text: string) {
		return `~${text}~`;
	},
};
const fakeTui = { requestRender() {} };
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Registered>();
	const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: Registered & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerShortcut(key: string, registration: { handler(ctx: ExtensionContext): Promise<void> }) {
			shortcuts.set(key, registration);
		},
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: ExtensionContext, payload: unknown = {}) => {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
		return last;
	};
	return { pi, tools, shortcuts, fire };
}

function fakeContext(branch: unknown[] = [], hasUI = true, manager?: SessionManager) {
	const widgets = new Map<string, (tui: unknown, theme: unknown) => Component>();
	const ctx = {
		hasUI,
		sessionManager: manager ?? { getSessionId: () => "s1", getBranch: () => branch, buildSessionProjection: () => ({ messages: [] }) },
		ui: {
			setWidget(key: string, content: ((tui: unknown, theme: unknown) => Component) | undefined) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
		},
	} as unknown as ExtensionContext;
	const widgetComponent = () => {
		const factory = widgets.get("gentle-todo");
		return factory?.(fakeTui, plainTheme);
	};
	const widget = () => widgetComponent()?.render(70).map(stripAnsi);
	return { ctx, widgets, widget, widgetComponent };
}

test("todoEnabled and todoCollapseKey read their environment flags", () => {
	assert.equal(todoEnabled({}), true);
	assert.equal(todoEnabled({ GENTLE_PI_TODO: "0" }), false);
	assert.equal(todoEnabled({ GENTLE_PI_AGENTS_CHILD: "1" }), false);
	assert.equal(todoCollapseKey({}), "ctrl+shift+t");
	assert.equal(todoCollapseKey({ GENTLE_PI_TODO_KEY: "alt+t" }), "alt+t");
	assert.equal(todoCollapseKey({ GENTLE_PI_TODO_KEY: "off" }), undefined);
	const off = fakePi();
	gentleTodo(off.pi, { GENTLE_PI_TODO: "off" });
	assert.equal(off.tools.size, 0);
});

test("todo registration owns its transparent transcript shell", () => {
	const { pi, tools } = fakePi();
	gentleTodo(pi, {});
	assert.equal(tools.get("todo")?.renderShell, "self");
});

test("the todo tool writes the list, shows the card after the call, and carries the snapshot in details", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	assert.equal(widget(), undefined, "no card without tasks");

	const tool = tools.get("todo")!;
	const result = await tool.execute("c1", { action: "write", tasks: [{ title: "Write the parser", status: "in_progress", note: "parsing" }, { title: "Add tests" }] }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /2 tasks · 0 done · 1 in progress/);
	assert.equal((result.details.gentleTodo as { tasks: unknown[] }).tasks.length, 2);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const lines = widget()!;
	assert.match(lines[0], /^╭─ ❀ Todos ▾ Collapse · 0 of 2 ─+ ctrl\+shift\+t collapse ╮$/);
	assert.match(lines[1], /◐ Write the parser · parsing/);
	assert.match(lines[2], /○ Add tests/);
	assert.equal(lines[lines.length - 1], "", "a blank line keeps the card off the prompt");

	const bad = await tool.execute("c2", { action: "update", id: 9, status: "done" }, undefined, undefined, ctx);
	assert.match(bad.content[0].text, /Error: no task #9/);
	assert.equal(bad.details.error, "no task #9");
	assert.match(tool.renderCall({ action: "write" }, plainTheme).render(40).join(""), /❀ todo · write/);
	assert.equal(tool.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false }, plainTheme).render(40).join("|").trimEnd(), "a");
});

test("the Todo header is a fullscreen left-click control while non-click pointer events stay inert", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widgetComponent } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "in_progress" }, { title: "B" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });

	const component = widgetComponent()!;
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/);
	const event = (type: "press" | "click", button: "left" | "right", y = 0) => ({
		type, button, x: 1, y, screenX: 1, screenY: y, width: 70, height: 5, shift: false, alt: false, ctrl: false,
	});
	assert.equal(component.handleMouse?.(event("press", "left")), undefined);
	assert.equal(component.handleMouse?.(event("click", "right")), undefined);
	assert.equal(component.handleMouse?.(event("click", "left", 1)), undefined);
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/, "only a left click on the header toggles");
	assert.equal(component.handleMouse?.(event("click", "left"))?.handled, true);
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▸ Expand/);
});

// H1 (odd/tasks/usage-click-and-changes-attribution.md): the header control
// now paints the same shared hover role every other clickable surface uses.
test("the Todo header paints the shared hover role while hovered, and clears it off the header row or on leave", async () => {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widgetComponent } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	const component = widgetComponent()!;
	const move = (y: number) => ({ type: "move" as const, button: "none" as const, x: 1, y, screenX: 1, screenY: y, width: 70, height: 5, shift: false, alt: false, ctrl: false });
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/);

	const entered = component.handleMouse?.(move(0));
	assert.deepEqual(entered, { handled: true, render: true });
	assert.match(stripAnsi(component.render(70)[0]!), /Todos ▾ Collapse/, "the collapse label is unchanged; only its role changes (not observable through plainTheme here)");

	// Moving to another row of the card (still inside the region, but off the
	// clickable header) clears the hover.
	const movedOff = component.handleMouse?.(move(1));
	assert.deepEqual(movedOff, { handled: true, render: true });

	// Re-entering, then a second move at the same row is a no-op (already hovered).
	component.handleMouse?.(move(0));
	assert.deepEqual(component.handleMouse?.(move(0)), { handled: true });
});

test("in the float style the Todos header sits on row 1 below the top padding, and hover and click work there", async (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widgets } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "in_progress" }, { title: "B" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	setCardStyle(CARD_STYLE.FLOAT);
	// Float panels need a theme background; without one they keep the frame.
	const theme = { ...plainTheme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	const component = widgets.get("gentle-todo")!(fakeTui, theme);
	const rows = component.render(70).map(stripAnsi);
	assert.match(rows[0]!, /^ ▎ +$/, "a padding row sits above the header");
	assert.match(rows[1]!, /^ ▎ ❀ Todos ▾ Collapse  0 of 2 +ctrl\+shift\+t {3}$/);
	assert.match(rows[2]!, /^ ▎ +$/, "a blank separator row follows the header");
	assert.match(rows[3]!, /^ ▎ ◐ A/);
	assert.doesNotMatch(rows.join("\n"), /[╭╮╰╯│]/u);
	assert.equal(rows.at(-1), "", "the spacer row still keeps the card off the prompt");
	const pointer = (type: "move" | "click", y: number) => ({
		type, button: type === "move" ? "none" as const : "left" as const, x: 1, y, screenX: 1, screenY: y, width: 70, height: rows.length, shift: false, alt: false, ctrl: false,
	});
	assert.deepEqual(component.handleMouse?.(pointer("move", 1)), { handled: true, render: true }, "the header row is hoverable");
	assert.deepEqual(component.handleMouse?.(pointer("move", 3)), { handled: true, render: true }, "a body row clears the hover");
	assert.equal(component.handleMouse?.(pointer("click", 0)), undefined, "the padding row is not the control");
	assert.equal(component.handleMouse?.(pointer("click", 2)), undefined, "the separator row is not the control");
	assert.equal(component.handleMouse?.(pointer("click", 3)), undefined, "a body row is not the control");
	assert.equal(component.handleMouse?.(pointer("click", 1))?.handled, true);
	assert.match(stripAnsi(component.render(70)[1]!), /^ ▎ ❀ Todos ▸ Expand  0 of 2 /);
});

function promptEvent(): { systemPrompt: string; systemPromptOptions: { appendSystemPrompt: string } } {
	return { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
}

function cacheHarness(manager = SessionManager.inMemory("/todo-test"), env: NodeJS.ProcessEnv = {}) {
	const { pi, tools, fire } = fakePi();
	gentleTodo(pi, env);
	const { ctx, widget } = fakeContext([], true, manager);
	const update = async (params: unknown) => {
		const result = await tools.get("todo")!.execute("call", params, undefined, undefined, ctx);
		manager.appendMessage({
			role: "toolResult", toolCallId: "call", toolName: "todo", timestamp: 0,
			content: result.content.map((part) => ({ type: "text", text: part.text })),
			details: JSON.parse(JSON.stringify(result.details)), isError: !!result.details.error,
		});
		await fire("tool_execution_end", ctx, { toolName: "todo" });
	};
	const turn = async () => {
		const event = promptEvent();
		const result = await fire("before_agent_start", ctx, event) as BeforeAgentStartEventResult | undefined;
		assert.deepEqual(event, promptEvent(), "todo must never mutate system prompt options");
		assert.equal(result?.systemPrompt, undefined);
		// Match agent-session.prompt(): the user precedes the returned custom
		// message, which message_end persists without a continuation request.
		manager.appendMessage({ role: "user", content: "continue", timestamp: 0 });
		if (result?.message) {
			const message = result.message;
			assert.equal(message.customType, "gentle-todo");
			assert.equal(message.display, false);
			manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		}
		return result?.message;
	};
	return { manager, ctx, widget, update, turn, start: () => fire("session_start", ctx), tree: () => fire("session_tree", ctx), end: () => fire("agent_end", ctx) };
}

test("snapshots keep the prompt stable across five unchanged turns and preserve stale UI counters", async () => {
	const h = cacheHarness();
	await h.start();
	assert.equal(await h.turn(), undefined, "initial empty state is silent");
	await h.update({ action: "write", tasks: [{ title: "Fix the bug" }] });
	assert.match((await h.turn())!.content as string, /1\. \[pending\] #1 Fix the bug/);
	assert.doesNotMatch(h.widget()![1], /stale/);
	assert.match((await h.turn())!.content as string, /bring the list up to date now/);
	assert.match(h.widget()![0], /ctrl\+shift\+t collapse/);
	assert.match(h.widget()![1], /stale · 2 turns/);
	for (let i = 0; i < 5; i++) assert.equal(await h.turn(), undefined);
	assert.match(h.widget()![1], /stale · 7 turns/);
	assert.equal(h.manager.getBranch().filter((e) => e.type === "custom_message").length, 2);
	const messages = h.manager.buildSessionProjection().messages;
	const first = messages.findIndex((m) => m.role === "custom");
	assert.equal(messages[first - 1].role, "user");
});

test("resuming stale work without a snapshot combines state and reminder in one persisted message", async () => {
	let h = cacheHarness();
	await h.start();
	await h.update({ action: "add", title: "A" });
	for (let i = 0; i < 2; i++) h.manager.appendMessage({ role: "user", content: "earlier", timestamp: 0 });
	h = cacheHarness(h.manager);
	await h.start();
	const message = (await h.turn())!;
	assert.match(message.content as string, /#1 A/);
	assert.match(message.content as string, /bring the list up to date now/);
	for (let i = 0; i < 5; i++) assert.equal(await h.turn(), undefined);
	assert.equal(h.manager.getBranch().filter((e) => e.type === "custom_message").length, 1);
});

test("title, status, note and ordering changes append snapshots, including a return to older content", async () => {
	const h = cacheHarness();
	await h.start();
	await h.update({ action: "write", tasks: [{ title: "A" }, { title: "B" }] });
	await h.turn();
	for (const change of [{ title: "Edited" }, { status: "in_progress" }, { note: "working" }, { title: "A", status: "pending", note: "" }]) {
		await h.update({ action: "update", id: 1, ...change });
		assert.ok(await h.turn(), "each changed snapshot is delivered");
	}
	await h.update({ action: "write", tasks: [{ id: 2, title: "B" }, { id: 1, title: "A" }] });
	assert.match((await h.turn())!.content as string, /1\. \[pending\] #2 B/);
});

test("stale reminders are one-shot across resume; only successful mutations rearm them", async () => {
	let h = cacheHarness();
	await h.start();
	await h.update({ action: "add", title: "A" });
	await h.turn();
	await h.turn();
	h = cacheHarness(h.manager);
	await h.start();
	await h.update({ action: "list" });
	await h.update({ action: "update", id: 99, status: "done" });
	assert.equal(await h.turn(), undefined);
	await h.update({ action: "update", id: 1, title: "A" });
	h = cacheHarness(h.manager);
	await h.start();
	assert.equal(await h.turn(), undefined, "identical content needs no new snapshot");
	assert.match((await h.turn())!.content as string, /bring the list up to date now/);
	assert.equal(await h.turn(), undefined);
});

test("resume and tree navigation replay branch state and restore only missing snapshots", async () => {
	let h = cacheHarness();
	await h.start();
	await h.update({ action: "add", title: "A" });
	const taskEntry = h.manager.getLeafId()!;
	await h.turn();
	h = cacheHarness(h.manager);
	await h.start();
	assert.match((await h.turn())!.content as string, /bring the list up to date now/);
	assert.equal(await h.turn(), undefined);
	await h.update({ action: "update", id: 1, title: "B" });
	await h.turn();
	h.manager.branch(taskEntry);
	await h.tree();
	assert.match((await h.turn())!.content as string, /#1 A/);
	assert.doesNotMatch(h.widget()!.join("\n"), /○ B/);
});

for (const recovery of ["retained", "compacted", "omitted", "replaced"] as const) {
	test(`effective context ${recovery}: reinjection respects projection, not raw branch history`, async () => {
		let h = cacheHarness();
		await h.start();
		await h.update({ action: "add", title: "A" });
		await h.turn();
		await h.turn();
		const snapshot = h.manager.getLeafId()!;
		const boundary = h.manager.appendMessage({ role: "user", content: "later", timestamp: 0 });
		if (recovery === "retained") h.manager.appendCompaction("summary", snapshot, 100);
		if (recovery === "compacted") h.manager.appendCompaction("summary", boundary, 100);
		if (recovery === "omitted") {
			for (const entry of h.manager.getBranch()) if (entry.type === "custom_message") h.manager.appendContextEdit(entry.id, null);
		}
		if (recovery === "replaced") h.manager.appendContextEdit(snapshot, { content: "obsolete" });
		assert.ok(h.manager.getBranch().some((e) => e.id === snapshot), "raw history still contains the snapshot");
		h = cacheHarness(h.manager);
		await h.start();
		const delivered = await h.turn();
		if (recovery === "retained") assert.equal(delivered, undefined);
		else {
			assert.match(delivered!.content as string, /#1 A/);
			assert.doesNotMatch(delivered!.content as string, /bring the list up to date now/, "compaction does not rearm a spent nudge");
		}
		assert.equal(await h.turn(), undefined);
	});
}

test("cleared and completed lists supersede active snapshots once, including after resume", async () => {
	for (const action of ["clear", "done"] as const) {
		let h = cacheHarness();
		await h.start();
		await h.update({ action: "add", title: "A" });
		await h.turn();
		await h.update(action === "clear" ? { action } : { action: "update", id: 1, status: "done" });
		await h.end();
		assert.match((await h.turn())!.content as string, /No active todo tasks/);
		assert.equal(h.widget(), undefined);
		h = cacheHarness(h.manager);
		await h.start();
		assert.equal(await h.turn(), undefined);
	}
});

test("GENTLE_PI_TODO=0 emits no snapshots or prompt changes", async () => {
	const h = cacheHarness(undefined, { GENTLE_PI_TODO: "0" });
	await h.start();
	for (let i = 0; i < 6; i++) assert.equal(await h.turn(), undefined);
});

test("a finished list stays for its turn and clears at the next, and the collapse key folds the card", async () => {
	const { pi, tools, shortcuts, fire } = fakePi();
	gentleTodo(pi, {});
	const { ctx, widget } = fakeContext();
	await fire("session_start", ctx);
	await tools.get("todo")!.execute("c1", { action: "write", tasks: [{ title: "A", status: "in_progress" }, { title: "B" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	await shortcuts.get("ctrl+shift+t")!.handler(ctx);
	assert.equal(widget()!.length, 4, "collapsed: top, one row, bottom, spacer");
	assert.match(widget()![1], /◐ A/);
	await shortcuts.get("ctrl+shift+t")!.handler(ctx);
	assert.equal(widget()!.length, 5);

	await tools.get("todo")!.execute("c2", { action: "write", tasks: [{ id: 1, title: "A", status: "done" }, { id: 2, title: "B", status: "done" }] }, undefined, undefined, ctx);
	await fire("tool_execution_end", ctx, { toolName: "todo" });
	await fire("agent_end", ctx);
	assert.match(widget()![0], /Todos ▾ Collapse · 2 of 2/, "the finished list is still visible at the end of its turn");
	const next = await fire("before_agent_start", ctx, { systemPrompt: "base" });
	assert.match((next as BeforeAgentStartEventResult).message!.content as string, /No active todo tasks/, "finished work supersedes old active snapshots");
	assert.equal(widget(), undefined, "the card clears at the next turn");
});

test("session_start replays the list from the branch, rpiv-todo results included, and counts past turns", async () => {
	const { pi, fire } = fakePi();
	gentleTodo(pi, {});
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { action: "create", params: {}, tasks: [{ id: 1, subject: "Old task", status: "in_progress", activeForm: "still going" }], nextId: 2 } } },
		{ type: "message", message: { role: "user", content: "again" } },
	];
	const { ctx, widget } = fakeContext(branch);
	await fire("session_start", ctx);
	const lines = widget()!;
	assert.match(lines[0], /Todos ▾ Collapse · 0 of 1/);
	assert.match(lines[1], /◐ Old task · still going/);
	const headless = fakeContext(branch, false);
	await fire("session_start", headless.ctx);
	assert.equal(headless.widget(), undefined);
});

test("session_start drops a list that was already finished, so a reload never shows stale done work", async () => {
	const { pi, fire } = fakePi();
	gentleTodo(pi, {});
	const finished = [
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { gentleTodo: { tasks: [{ id: 1, title: "Done A", status: "done" }, { id: 2, title: "Done B", status: "done" }], nextId: 3, updatedTurn: 1 } } } },
	];
	const { ctx, widget } = fakeContext(finished);
	await fire("session_start", ctx);
	assert.equal(widget(), undefined, "nothing to show after a reload of finished work");
	const prompt = (await fire("before_agent_start", ctx, { systemPrompt: "base" })) as BeforeAgentStartEventResult;
	assert.match(prompt.message!.content as string, /No active todo tasks/, "finished work is not reinjected as active");
});
