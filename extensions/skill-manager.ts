import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");

function findSkills(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(root, "SKILL.md"))) out.push(root);
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(root, e.name);
    if (fs.existsSync(path.join(p, "SKILL.md"))) out.push(p);
    else out.push(...findSkills(p));
  }
  return out;
}

function skillName(dir: string): string {
  const fm = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  const m = fm.match(/^name:\s*(\S+)/m);
  return m ? m[1] : path.basename(dir);
}

function install(ownerRepo: string, skillFilter?: string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-"));
  try {
    execSync(`git clone --depth 1 https://github.com/${ownerRepo} "${tmp}"`, { stdio: "pipe" });
    let dirs = findSkills(tmp);
    if (dirs.length === 0) throw new Error(`No SKILL.md found in ${ownerRepo}`);
    if (skillFilter) {
      dirs = dirs.filter((d) => path.basename(d) === skillFilter || skillName(d) === skillFilter);
      if (dirs.length === 0) throw new Error(`Skill "${skillFilter}" not found in ${ownerRepo}`);
    }
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const names: string[] = [];
    for (const d of dirs) {
      const name = skillName(d);
      const dest = path.join(SKILLS_DIR, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(d, dest, { recursive: true });
      names.push(name);
    }
    return names;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("skill", {
    description: "Manage skills: /skill add <owner>/<repo>[/skill], /skill list, /skill remove <name>",
    getArgumentCompletions: (prefix) => {
      const subs = ["add", "list", "remove"].filter((s) => s.startsWith(prefix));
      return subs.length ? subs.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args, ctx) => {
      const [sub, target, name] = args.trim().split(/\s+/);

      if (sub === "add" && target?.includes("/")) {
        const parts = target.split("/");
        const skill = parts.length > 2 ? parts.slice(2).join("/") : undefined;
        try {
          // Skills can contain code the model executes — confirm before installing.
          if (
            !(await ctx.ui.confirm(
              `Install skill${skill ? ` "${skill}"` : "s"} from ${target}? (Skills run code — review before use.)`,
              "Install skill?",
            ))
          )
            return;
          const installed = install(parts.slice(0, 2).join("/"), skill);
          ctx.ui.notify(`Installed: ${installed.join(", ")} → ${SKILLS_DIR}`, "info");
          await ctx.reload(); // re-scan skills so /skill:<name> works immediately
        } catch (e: any) {
          ctx.ui.notify(`Install failed: ${e.message}`, "error");
        }
        return;
      }
      if (sub === "list") {
        const list = fs.existsSync(SKILLS_DIR)
          ? fs
              .readdirSync(SKILLS_DIR, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => `• ${e.name}`)
              .join("\n") || "(none)"
          : "(none)";
        ctx.ui.notify(`Skills in ${SKILLS_DIR}:\n${list}`, "info");
        return;
      }
      if (sub === "remove" && name) {
        const p = path.join(SKILLS_DIR, name);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { recursive: true, force: true });
          ctx.ui.notify(`Removed ${name}`, "info");
        } else {
          ctx.ui.notify(`Not found: ${name}`, "error");
        }
        return;
      }
      ctx.ui.notify("Usage: /skill add <owner>/<repo>[/skill] | /skill list | /skill remove <name>", "info");
    },
  });
}
