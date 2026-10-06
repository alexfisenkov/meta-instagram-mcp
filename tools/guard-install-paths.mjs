#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function effectivePath(input, label) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("missing path");
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let cursor = absolute;
  const missing = [];

  while (true) {
    try {
      fs.lstatSync(cursor);
      let resolved;
      try {
        resolved = fs.realpathSync.native(cursor);
      } catch {
        throw new Error("unresolvable existing path");
      }
      return path.resolve(resolved, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`cannot safely resolve ${label}`);
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor || cursor === root) throw new Error(`cannot safely resolve ${label}`);
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

function comparisonPath(value) {
  let result = path.resolve(value).replace(/[\\/]+$/, "");
  if (!result) result = path.parse(value).root;
  return process.platform === "win32" ? result.toLocaleLowerCase("en-US") : result;
}

function contains(parent, candidate) {
  const normalizedParent = comparisonPath(parent);
  const normalizedCandidate = comparisonPath(candidate);
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function main() {
  const [targetInput, configInput] = process.argv.slice(2);
  const target = effectivePath(targetInput, "target");
  const config = effectivePath(configInput, "config directory");
  const root = path.parse(target).root;
  const home = effectivePath(os.homedir(), "home directory");

  let targetEntry;
  try { targetEntry = fs.lstatSync(path.resolve(targetInput)); } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("cannot safely inspect installation target");
  }
  if (targetEntry?.isSymbolicLink()) throw new Error("refusing a symbolic-link installation target");
  if (comparisonPath(target) === comparisonPath(root) || comparisonPath(target) === comparisonPath(home)) {
    throw new Error("refusing an unsafe installation target");
  }
  if (contains(target, config) || contains(config, target)) {
    throw new Error("config directory and installation target must not overlap after resolving links");
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Installer path guard: ${error.message}\n`);
  process.exitCode = 1;
}
