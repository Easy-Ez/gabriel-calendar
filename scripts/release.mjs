import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const nodeManifest = "sdks/node/package.json";
const pythonProject = "sdks/python";
const mainRef = "refs/heads/main";
const usage = `Usage: npm run release -- [--dry-run] [--only node|python] [--version X.Y.Z]

By default, plan a patch release for both SDKs. Use --version for an explicit
stable version. A dry run prints the plan without modifying files or Git refs.
After confirmation, the command commits the version files and atomically pushes
main and the selected tags to origin. GitHub Actions builds and publishes them.`;

function run(command, args, failure) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(failure);
  }
}

function git(...args) {
  return run("git", args, `Git ${args[0]} failed.`);
}

const sdks = [
  {
    name: "node",
    files: [nodeManifest, "package-lock.json"],
    version: () => JSON.parse(readFileSync(new URL(`../${nodeManifest}`, import.meta.url), "utf8")).version,
    bump(version) {
      run("npm", ["version", version, "--workspace", "gabriel-calendar", "--no-git-tag-version", "--ignore-scripts", "--workspaces-update=false"], "Could not update the Node.js version.");
      run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], "Could not update package-lock.json.");
    },
  },
  {
    name: "python",
    files: [`${pythonProject}/pyproject.toml`, `${pythonProject}/uv.lock`],
    version: () => run("uv", ["version", "--project", pythonProject, "--short"], "Could not read the Python version with uv."),
    bump(version) {
      run("uv", ["version", "--project", pythonProject, "--no-sync", "--default-index", "https://pypi.org/simple", version], "Could not update the Python version and uv.lock.");
    },
  },
];

function versionParts(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    throw new Error("Release versions must be stable X.Y.Z versions.");
  }
  return version.split(".").map(Number);
}

function checkMain() {
  if (git("branch", "--show-current") !== "main" || git("status", "--porcelain")) {
    throw new Error("Start the release from a clean main branch.");
  }
  return git("rev-parse", "HEAD");
}

async function release() {
  let options;
  try {
    ({ values: options } = parseArgs({ options: {
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      only: { type: "string" },
      version: { type: "string" },
    } }));
  } catch {
    throw new Error("Invalid release arguments. Run npm run release -- --help.");
  }
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.only !== undefined && !sdks.some(sdk => sdk.name === options.only)) {
    throw new Error("Use --only node or --only python.");
  }

  const selected = sdks.filter(sdk => !options.only || sdk.name === options.only);
  const plan = selected.map(sdk => {
    const current = sdk.version();
    const currentParts = versionParts(current);
    const [major, minor, patch] = currentParts;
    const next = options.version ?? `${major}.${minor}.${patch + 1}`;
    const parts = versionParts(next);
    const change = parts.findIndex((part, i) => part !== currentParts[i]);
    if (change < 0 || parts[change] < currentParts[change]) {
      throw new Error(`The ${sdk.name} release version must be newer than ${current}.`);
    }
    return { sdk, current, next, tag: `${sdk.name}-v${next}` };
  });

  console.log("Release plan");
  for (const { current, next, tag } of plan) console.log(`  ${current} → ${next} (${tag})`);
  if (options["dry-run"]) return;

  const base = checkMain();
  const tagRefs = plan.map(({ tag }) => `refs/tags/${tag}`);
  const remote = git("ls-remote", "--refs", "origin", mainRef, ...tagRefs);
  if (remote !== `${base}\t${mainRef}`) {
    throw new Error("origin/main must match local main and the release tags must be new.");
  }
  if (git("tag", "--list", ...plan.map(({ tag }) => tag))) {
    throw new Error("A release tag already exists locally.");
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (await prompt.question("Type yes to commit and push this release: ") !== "yes") return;
  } finally {
    prompt.close();
  }
  if (checkMain() !== base) throw new Error("main changed while confirming the release.");

  const files = plan.flatMap(({ sdk }) => sdk.files);
  const message = `Release ${plan.map(({ sdk, next }) => `${sdk.name} ${next}`).join(", ")}`;
  for (const { sdk, next } of plan) sdk.bump(next);
  git("commit", "--only", "-m", message, "--", ...files);
  const commit = git("rev-parse", "HEAD");
  for (const { tag } of plan) git("tag", "-a", tag, commit, "-m", tag);

  const refspecs = [`${commit}:${mainRef}`, ...tagRefs];
  try {
    git("push", "--atomic", "--no-follow-tags", "origin", ...refspecs);
  } catch {
    throw new Error(`Atomic push failed. The release commit and tags are available locally. Inspect origin before retrying with git push --atomic --no-follow-tags origin ${refspecs.join(" ")}`);
  }
  console.log(`Pushed ${plan.map(({ tag }) => tag).join(", ")}. Follow the release in GitHub Actions.`);
}

try {
  await release();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
