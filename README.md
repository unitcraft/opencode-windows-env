# opencode-windows-env

OpenCode V2 plugin: a sane **command environment on Windows** and a **time stamp** on agent
messages.

Before every shell command:

- Git Bash first in `PATH` (otherwise `bash` is WSL's, and scripts written for Git Bash see
  "not a git repository");
- `PYTHONUTF8=1`; Windows PowerShell 5.1 reads and prints UTF-8 (writes are left alone, so no
  BOM appears in files);
- `TEMP`/`TMP`/`TMPDIR` on the `Temp` directory of the drive the command runs on, when it
  exists (OpenCode itself breaks if `TEMP` points off the system drive, so the launcher cannot
  set it).

Time: the plugin rewrites the model's response stream and puts `HH:MM` before the first chunk
of every text block (Anthropic Messages, OpenAI Chat, OpenAI Responses), and refuses shell
calls that only ask the clock (`date "+%H:%M"`, `Get-Date -Format HH:mm`). The system hint it
adds is constant: a clock in the hint would change every minute and, sitting before the whole
history, re-bill it on every request with Claude's prefix prompt cache.

Stamps never reach the model: before a request goes out, the plugin cuts the leading `HH:MM` stamps from the assistant
messages of the history (Anthropic Messages, OpenAI Chat, OpenAI Responses; other roles and stamps inside a text are
left alone). Weaker models used to copy the stamps and pile up `02:31 02:31 ...` with old times; the cut is
deterministic, so the prefix cache is not broken. The stamp on the output is still put by the plugin.

A task journal needs the real time too, and the clock commands are refused: the project's own tool `progress_line`
(CrewHarness plugin) writes the time into `progress.log` itself.

Tabs on the [`claude-code` provider](https://github.com/unitcraft/opencode-claude-code-provider) are not
reached: Claude Code runs its own shell tools and model calls. There the provider stamps the time itself
(its setting `timeStamp`).

## Install

```sh
git clone https://github.com/unitcraft/opencode-windows-env C:/work/opencode-windows-env
```

`~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": ["C:/work/opencode-windows-env"]
```

## Related

Other OpenCode plugins of the same set (they work independently; together they are tested on one machine):

- [CrewHarness](https://github.com/unitcraft/crew-harness) — letters and tasks between OpenCode sessions on one machine, across windows and projects, addressed by `project.role`
- [opencode-claude-guards](https://github.com/unitcraft/opencode-claude-guards) — the repository's Claude Code rules (hooks, permissions) in OpenCode windows
- [opencode-claude-code-provider](https://github.com/unitcraft/opencode-claude-code-provider) — OpenCode provider `claude-code` on top of the official Claude Code

## Test

```sh
npm test   # node >= 24
```

History: moved with its commits from a private plugins repository of the nova project (`plugins/nova-env`).

License: MIT OR Apache-2.0 (see [LICENSE](LICENSE)).
