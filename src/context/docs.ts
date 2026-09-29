import type { Host } from "../host/types";
import type { WebConfig } from "../web/search";

/**
 * `@docs:<package>`: the README of the package version the project actually uses.
 * Local first (node_modules, Python site-packages); the npm or PyPI registry only
 * when web access is enabled.
 */

export interface PackageDocs {
  name: string;
  version?: string;
  source: string;
  text: string;
}

const README = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.rst", "README.txt", "README"];

export async function packageDocs(host: Host, name: string, web?: WebConfig, signal?: AbortSignal): Promise<PackageDocs | undefined> {
  return (await fromNodeModules(host, name)) ?? (await fromSitePackages(host, name)) ?? (web ? await fromRegistry(host, name, signal) : undefined);
}

async function read(host: Host, p: string): Promise<string | undefined> {
  return (await host.stat(p)) === "file" ? host.readFile(p).catch(() => undefined) : undefined;
}

async function fromNodeModules(host: Host, name: string): Promise<PackageDocs | undefined> {
  const dir = `node_modules/${name}`;
  const pkg = await read(host, `${dir}/package.json`);
  if (!pkg) return undefined;
  const version = safeVersion(pkg);
  for (const f of README) {
    const text = await read(host, `${dir}/${f}`);
    if (text) return { name, version, source: `${dir}/${f}`, text };
  }
  return { name, version, source: `${dir}/package.json`, text: "(no README in the installed package)" };
}

async function fromSitePackages(host: Host, name: string): Promise<PackageDocs | undefined> {
  const norm = name.toLowerCase().replace(/[-_.]+/g, "_");
  for (const venv of [".venv", "venv", "env"]) {
    if ((await host.stat(`${venv}/lib`)) !== "dir") continue;
    for (const py of await host.listDir(`${venv}/lib`)) {
      const site = `${venv}/lib/${py.name}/site-packages`;
      if ((await host.stat(site)) !== "dir") continue;
      const info = (await host.listDir(site)).find((e) => e.type === "dir" && e.name.toLowerCase().replace(/[-_.]+/g, "_").startsWith(norm + "_") && e.name.endsWith(".dist-info"));
      if (!info) continue;
      const meta = await read(host, `${site}/${info.name}/METADATA`);
      if (!meta) continue;
      const version = /^Version:\s*(.+)$/m.exec(meta)?.[1]?.trim();
      const body = meta.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
      return { name, version, source: `${site}/${info.name}/METADATA`, text: body || "(no description in the package metadata)" };
    }
  }
  return undefined;
}

/** The version the project asks for (package.json / requirements.txt / pyproject.toml), to match registry docs. */
async function wantedVersion(host: Host, name: string): Promise<{ eco: "npm" | "pypi"; version?: string } | undefined> {
  const pkg = await read(host, "package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      const v = j.dependencies?.[name] ?? j.devDependencies?.[name] ?? j.peerDependencies?.[name];
      if (v) return { eco: "npm", version: /(\d+\.\d+\.\d+)/.exec(v)?.[1] };
    } catch {
      /* invalid package.json */
    }
  }
  for (const f of ["requirements.txt", "pyproject.toml"]) {
    const t = await read(host, f);
    const m = t && new RegExp(`^\\s*["']?${name.replace(/[-_.]/g, "[-_.]")}\\s*(?:\\[[^\\]]*\\])?\\s*(?:==\\s*([\\w.]+))?`, "im").exec(t);
    if (m) return { eco: "pypi", version: m[1] };
  }
  return pkg ? { eco: "npm" } : undefined;
}

async function fromRegistry(host: Host, name: string, signal?: AbortSignal): Promise<PackageDocs | undefined> {
  const want = await wantedVersion(host, name);
  const timeout = AbortSignal.timeout(15_000);
  const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    if (!want || want.eco === "npm") {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { signal: s, headers: { Accept: "application/json" } });
      if (res.ok) {
        const j = (await res.json()) as { readme?: string; "dist-tags"?: { latest?: string } };
        const version = want?.version ?? j["dist-tags"]?.latest;
        if (j.readme) return { name, version, source: `npm registry (README of the latest release${want?.version ? `; the project uses ${want.version}` : ""})`, text: j.readme };
      }
    }
    if (!want || want.eco === "pypi") {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/${want?.version ? `${want.version}/` : ""}json`, { signal: s });
      if (res.ok) {
        const j = (await res.json()) as { info?: { description?: string; version?: string } };
        if (j.info?.description) return { name, version: j.info.version, source: "PyPI", text: j.info.description };
      }
    }
  } catch {
    /* offline or not found */
  }
  return undefined;
}

function safeVersion(pkgJson: string): string | undefined {
  try {
    return JSON.parse(pkgJson).version;
  } catch {
    return undefined;
  }
}
