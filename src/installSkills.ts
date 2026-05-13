import { spawnSync } from "node:child_process"
import { writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface InstallResult {
  /** 已安装的 spec 列表（按顺序）。 */
  installed: string[]
  /** 安装失败的 spec → 错误信息。 */
  failed: Array<{ spec: string; error: string }>
  /** 启动期诊断（如 HX_NPM_TOKEN 缺失但 spec 包含 scoped 包），entrypoint 写到 trace。 */
  warnings: string[]
}

/**
 * 写 ~/.npmrc，让 `pi install npm:...` 能从私有 GitLab npm registry 拉包。
 *
 * 只在 HX_NPM_TOKEN / HX_NPM_REGISTRY / HX_NPM_SCOPE 都给齐时写入。
 * 已存在的 .npmrc 不覆盖（避免覆盖调用方自己的配置）。
 */
function writeNpmrc(): void {
  const token = process.env.HX_NPM_TOKEN
  const registry = process.env.HX_NPM_REGISTRY
  const scope = process.env.HX_NPM_SCOPE
  if (!token || !registry || !scope) return

  const home = process.env.HOME ?? homedir()
  const path = join(home, ".npmrc")
  if (existsSync(path)) return

  const host = registry.replace(/^https?:/, "").replace(/\/$/, "")
  const content =
    `${scope}:registry=${registry}\n` + `${host}/:_authToken=${token}\n`
  writeFileSync(path, content, { mode: 0o600 })
}

/**
 * 运行期通过 `pi install npm:<spec>` 把 HX_SKILLS 列出的 spec 全局装到 ~/.pi/agent/。
 *
 * 全局安装而非 -l 项目级：让 pi 的 DefaultResourceLoader 走原生 settings.json
 * 自动发现这些 skill，避免我们手动维护 skill 目录扫描。
 */
export function installSystemSkills(): InstallResult {
  writeNpmrc()

  const specsCsv = (process.env.HX_SKILLS ?? "").trim()
  const installed: string[] = []
  const failed: Array<{ spec: string; error: string }> = []
  const warnings: string[] = []

  if (!specsCsv) return { installed, failed, warnings }

  const specs = specsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  // 若 spec 含 scoped npm 包但 HX_NPM_TOKEN 未设置，下面的 install 大概率 401/404。
  // 此处提前 warn，把 silent failure 变 visible failure（trace 里能直接看到）。
  const hasScoped = specs.some((s) => /^npm:@[^/]+\//.test(s))
  if (hasScoped && !process.env.HX_NPM_TOKEN) {
    warnings.push(
      "HX_SKILLS contains scoped npm specs but HX_NPM_TOKEN is unset; private registry installs will likely fail",
    )
  }

  for (const spec of specs) {
    const r = spawnSync("pi", ["install", spec], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    if (r.status === 0) {
      installed.push(spec)
    } else {
      const err = (r.stderr?.toString() ?? "") + (r.stdout?.toString() ?? "")
      failed.push({ spec, error: err.slice(0, 1000) || `exit ${r.status}` })
    }
  }

  return { installed, failed, warnings }
}
