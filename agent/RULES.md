# 浏览器操作

需要操作浏览器时，默认使用 Ego Lite 的 `ego-browser` 技能和命令，先读取技能并遵循其用法；不要默认使用 omp 内置 Chromium 或 Chrome relay。用户明确指定其他浏览器，或 Ego Lite 不可用且需要说明原因时除外。静态网页读取不受此规则影响。

## ego-browser 收尾释放

用 ego-browser 操作浏览器后，必须显式结束 TaskSpace，否则界面会一直显示「agent 正在控制」：

- 任务完成：脚本最后一步 `await task.finish({ keep: [] })`，等它 resolve 后再汇报；之后不得再操作该 Page。需要把结果页留给用户时才用 `keep: [...]`。
- 需要用户亲手操作（登录、确认、授权）：用 `await task.handOff()`，结束本轮并说明要用户做什么；确认后 `takeOverTaskSpace(id)` 继续。
- 不逐个 `page.close()` 收尾；已 finish 的 space 不要在同一任务里再次进入。

注：进程退出不等于释放控制，只有 `finish` / `handOff` 才把控制权交回用户。

# Karpathy-Inspired Coding Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
