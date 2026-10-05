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

Tabs on the [`claude-code` provider](https://github.com/unitcraft/opencode-claude-code-provider) are not
reached: Claude Code runs its own shell tools and model calls. There the provider stamps the time itself
(its setting `timeStamp`).

## Install

```sh
git clone https://github.com/unitcraft/opencode-windows-env D:/Sources/opencode-windows-env
```

`~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": ["D:/Sources/opencode-windows-env"]
```

## Related

Other OpenCode plugins of the same set (they work independently; together they are tested on one machine):

- [opencode-peers](https://github.com/unitcraft/opencode-peers) — letters and tasks between OpenCode tabs, addressed by `project.role`
- [opencode-claude-guards](https://github.com/unitcraft/opencode-claude-guards) — the repository's Claude Code rules (hooks, permissions) in OpenCode windows
- [opencode-claude-code-provider](https://github.com/unitcraft/opencode-claude-code-provider) — OpenCode provider `claude-code` on top of the official Claude Code

## Test

```sh
npm test   # node >= 24
```

History: moved with its commits from `nv-lang/nova-opencode-plugins` (`plugins/nova-env`).

License: MIT OR Apache-2.0 (see [LICENSE](LICENSE)).
