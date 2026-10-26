import { rmSync } from "node:fs";
import { $ } from "bun";

const git = async (...args) => {
  const r = await $`git ${args}`.quiet().nothrow();
  return r.exitCode === 0 ? r.text().trim() : null;
};

// 버전 정보는 로컬 main 브랜치 기준, git checkout 이 아니면 "unknown"
const hash = await git("log", "main", "-1", "--pretty=format:%h");
if (!hash) console.warn("Git command failed, using default values.");
const gitInfo = {
  __LAST_VERSION_TAG__: hash && ((await git("describe", "main", "--tags", "--exact-match")) ?? "develop"),
  __LAST_COMMIT_HASH__: hash,
  __LAST_COMMIT_DATE__: await git("log", "main", "-1", "--date=format:%Y-%m-%d %H:%M", "--pretty=format:%cd"),
  __LAST_COMMIT_MESSAGE__: await git("log", "main", "-1", "--pretty=format:%s"),
};
const define = Object.fromEntries(Object.entries(gitInfo).map(([k, v]) => [k, JSON.stringify(v ?? "unknown")]));

rmSync("dist", { recursive: true, force: true });
await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  minify: true,
  publicPath: "/sbbs/",
  env: "PUBLIC_*",
  define,
});

// Bun 은 HTML 의 %ENV% 를 치환하지 않으므로 직접 바꾼다.
const html = Bun.file("dist/index.html");
await Bun.write(html, (await html.text()).replace("%PUBLIC_SUPABASE_URL%", process.env.PUBLIC_SUPABASE_URL));
