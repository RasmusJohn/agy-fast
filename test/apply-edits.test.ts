import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runApplyEdits } from "../src/tools/apply-edits.js";

describe("apply_edits", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-edits-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies multiple non-contiguous hunks across multiple files atomically", async () => {
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    await fs.writeFile(
      fileA,
      ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n"),
      "utf8",
    );
    await fs.writeFile(fileB, "export const flag = false;\n", "utf8");

    const res = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "a.ts",
          hunks: [
            { target: "const a = 1;", replacement: "const a = 10;" },
            { target: "const d = 4;", replacement: "const d = 40;" },
          ],
        },
        {
          path: "b.ts",
          hunks: [
            { target: "flag = false", replacement: "flag = true" },
          ],
        },
        {
          path: "nested/created.txt",
          create: "hello new file\n",
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.equal(
      await fs.readFile(fileA, "utf8"),
      ["const a = 10;", "const b = 2;", "const c = 3;", "const d = 40;"].join("\n"),
    );
    assert.equal(await fs.readFile(fileB, "utf8"), "export const flag = true;\n");
    assert.equal(
      await fs.readFile(path.join(tmpDir, "nested", "created.txt"), "utf8"),
      "hello new file\n",
    );
  });

  it("modifies zero files when any hunk fails across any file (all-or-nothing)", async () => {
    const goodFile = path.join(tmpDir, "good.txt");
    const badFile = path.join(tmpDir, "bad.txt");
    await fs.writeFile(goodFile, "original good\n", "utf8");
    await fs.writeFile(badFile, "original bad\n", "utf8");

    const res = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "good.txt",
          hunks: [{ target: "original good", replacement: "MODIFIED GOOD" }],
        },
        {
          path: "bad.txt",
          hunks: [{ target: "nonexistent text", replacement: "nope" }],
        },
      ],
    });

    assert.equal(res.isError, true);
    assert.match(res.text, /0 files modified/);
    assert.equal(await fs.readFile(goodFile, "utf8"), "original good\n");
    assert.equal(await fs.readFile(badFile, "utf8"), "original bad\n");
  });

  it("uses startLine/endLine to disambiguate duplicate text and rejects ambiguous matches", async () => {
    const dupFile = path.join(tmpDir, "dup.ts");
    await fs.writeFile(
      dupFile,
      [
        "function one() {",
        "  return value;",
        "}",
        "function two() {",
        "  return value;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const ambig = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "dup.ts",
          hunks: [{ target: "return value;", replacement: "return 2;" }],
        },
      ],
    });
    assert.equal(ambig.isError, true);
    assert.match(ambig.text, /matched 2 times \(lines: 2, 5\)/);

    const anchored = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "dup.ts",
          hunks: [
            {
              target: "return value;",
              replacement: "return 2;",
              startLine: 4,
              endLine: 6,
            },
          ],
        },
      ],
    });
    assert.equal(anchored.isError, false);
    const updated = await fs.readFile(dupFile, "utf8");
    assert.match(updated, /one\(\) \{\n  return value;/);
    assert.match(updated, /two\(\) \{\n  return 2;/);
  });

  it("supports replaceAll, merges duplicate file entries, and rejects overlapping hunks", async () => {
    const f = path.join(tmpDir, "merge.txt");
    await fs.writeFile(f, "alpha beta alpha gamma\n", "utf8");

    const overlap = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "merge.txt",
          hunks: [
            { target: "alpha beta", replacement: "X" },
            { target: "beta alpha", replacement: "Y" },
          ],
        },
      ],
    });
    assert.equal(overlap.isError, true);
    assert.match(overlap.text, /overlap/);

    const merged = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "merge.txt",
          hunks: [{ target: "alpha", replacement: "ALPHA", replaceAll: true }],
        },
        {
          path: "merge.txt",
          hunks: [{ target: "gamma", replacement: "GAMMA" }],
        },
      ],
    });
    assert.equal(merged.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "ALPHA beta ALPHA GAMMA\n");
  });

  it("preserves CRLF line endings and supports dryRun", async () => {
    const crlfFile = path.join(tmpDir, "win.txt");
    await fs.writeFile(crlfFile, "line1\r\nline2\r\nline3\r\n", "utf8");

    const dry = await runApplyEdits({
      cwd: tmpDir,
      dryRun: true,
      edits: [
        {
          path: "win.txt",
          hunks: [{ target: "line1\nline2", replacement: "LINE1\nLINE2" }],
        },
      ],
    });
    assert.equal(dry.isError, false);
    assert.match(dry.text, /Dry run/);
    assert.equal(await fs.readFile(crlfFile, "utf8"), "line1\r\nline2\r\nline3\r\n");

    const real = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "win.txt",
          hunks: [{ target: "line1\nline2", replacement: "LINE1\nLINE2" }],
        },
      ],
    });
    assert.equal(real.isError, false);
    assert.equal(await fs.readFile(crlfFile, "utf8"), "LINE1\r\nLINE2\r\nline3\r\n");
  });

  it("runs inline verify command on pass and fail", async () => {
    const f = path.join(tmpDir, "check.js");
    await fs.writeFile(f, "const x = 1;\n", "utf8");

    const passRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "check.js", hunks: [{ target: "x = 1", replacement: "x = 2" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} -e "console.log('12 tests passed')"`,
    });
    assert.equal(passRes.isError, false);
    assert.match(passRes.text, /Verify \[PASS/);
    assert.match(passRes.text, /12 tests passed/);

    const failRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "check.js", hunks: [{ target: "x = 2", replacement: "x = 3" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} -e "console.error('TypeError: bad value'); process.exit(1)"`,
    });
    assert.equal(failRes.isError, false);
    assert.match(failRes.text, /Verify \[FAIL \(exit 1\)/);
    assert.match(failRes.text, /TypeError: bad value/);
    assert.equal(await fs.readFile(f, "utf8"), "const x = 3;\n");
  });

  it("refuses overwriting existing file with create unless overwrite is true", async () => {
    const f = path.join(tmpDir, "exist.txt");
    await fs.writeFile(f, "keep me\n", "utf8");

    const blocked = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "exist.txt", create: "new\n" }],
    });
    assert.equal(blocked.isError, true);
    assert.equal(await fs.readFile(f, "utf8"), "keep me\n");

    const allowed = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "exist.txt", create: "replaced\n", overwrite: true }],
    });
    assert.equal(allowed.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "replaced\n");
  });

  it("preserves file permissions, follows symlinks, reports accurate line counts, and validates line bounds", async () => {
    const scriptPath = path.join(tmpDir, "tool.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\necho v1\n", "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(scriptPath, 0o755);
    }

    const realFile = path.join(tmpDir, "real-target.txt");
    const symFile = path.join(tmpDir, "sym-link.txt");
    await fs.writeFile(realFile, "hello link\n", "utf8");
    await fs.symlink(realFile, symFile);

    const editRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "tool.sh", hunks: [{ target: "v1", replacement: "v2" }] },
        { path: "sym-link.txt", hunks: [{ target: "hello", replacement: "updated" }] },
        { path: "real-target.txt", hunks: [{ target: "link", replacement: "target" }] },
        { path: "single-line.txt", create: "only one line\n" },
      ],
    });

    assert.equal(editRes.isError, false);
    assert.match(editRes.text, /single-line\.txt: created, lines \+1/);
    assert.equal(await fs.readFile(scriptPath, "utf8"), "#!/bin/sh\necho v2\n");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(scriptPath)).mode & 0o777, 0o755);
    }
    assert.equal((await fs.lstat(symFile)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(realFile, "utf8"), "updated target\n");

    const badLine = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "real-target.txt",
          hunks: [{ target: "updated", replacement: "x", startLine: Number.NaN }],
        },
      ],
    });
    assert.equal(badLine.isError, true);
    assert.match(badLine.text, /Invalid startLine/);
  });

  it("rolls back content and permissions if a later write fails in Phase 2", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const okPath = path.join(tmpDir, "rb-ok.sh");
    const lockedDir = path.join(tmpDir, "rb-locked");
    const lockedFile = path.join(lockedDir, "blocked.txt");
    await fs.mkdir(lockedDir, { recursive: true });
    await fs.writeFile(okPath, "#!/bin/sh\necho orig\n", "utf8");
    await fs.chmod(okPath, 0o755);
    await fs.writeFile(lockedFile, "locked orig\n", "utf8");
    await fs.chmod(lockedFile, 0o444);
    await fs.chmod(lockedDir, 0o555);

    try {
      const res = await runApplyEdits({
        cwd: tmpDir,
        edits: [
          { path: "rb-ok.sh", hunks: [{ target: "orig", replacement: "changed" }] },
          { path: "rb-locked/blocked.txt", hunks: [{ target: "orig", replacement: "changed" }] },
        ],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /rolled back/);
      assert.equal(await fs.readFile(okPath, "utf8"), "#!/bin/sh\necho orig\n");
      assert.equal((await fs.stat(okPath)).mode & 0o777, 0o755);
    } finally {
      await fs.chmod(lockedDir, 0o755);
      await fs.chmod(lockedFile, 0o644);
    }
  });
});
