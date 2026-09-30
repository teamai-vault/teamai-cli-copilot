import { cp, link, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") {
      return false;
    }
    throw error;
  }
}

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  const contents = await readTextIfExists(filePath);
  return contents === undefined ? undefined : (JSON.parse(contents) as T);
}

export async function atomicWriteText(filePath: string, contents: string): Promise<void> {
  await atomicWriteFile(filePath, Buffer.from(contents, "utf8"));
}

export async function atomicWriteFile(filePath: string, contents: Uint8Array): Promise<void> {
  await atomicWriteFileWithMode(filePath, contents, false);
}

export async function atomicCreateFile(filePath: string, contents: Uint8Array): Promise<void> {
  await atomicWriteFileWithMode(filePath, contents, true);
}

async function atomicWriteFileWithMode(filePath: string, contents: Uint8Array, exclusive: boolean): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await open(tempPath, "wx").then(async (handle) => {
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    if (exclusive) {
      // Linking the completed temporary file is atomic and fails with EEXIST instead of replacing a frozen payload.
      await link(tempPath, filePath);
      await unlink(tempPath);
    } else {
      await rename(tempPath, filePath);
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function replaceDirectory(source: string, target: string): Promise<void> {
  const parent = path.dirname(target);
  const suffix = `${process.pid}.${Date.now()}`;
  const temporary = path.join(parent, `.${path.basename(target)}.${suffix}.tmp`);
  const backup = path.join(parent, `.${path.basename(target)}.${suffix}.bak`);
  await mkdir(parent, { recursive: true });
  await cp(source, temporary, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  let hadTarget = false;
  try {
    await rename(target, backup);
    hadTarget = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, target);
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget) await rename(backup, target);
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function directoriesEqual(source: string, target: string): Promise<boolean> {
  try {
    const [sourceInfo, targetInfo] = await Promise.all([lstat(source), lstat(target)]);
    if (!sourceInfo.isDirectory() || !targetInfo.isDirectory() || sourceInfo.isSymbolicLink() || targetInfo.isSymbolicLink()) {
      return false;
    }
    const [sourceEntries, targetEntries] = await Promise.all([
      readdir(source, { withFileTypes: true }),
      readdir(target, { withFileTypes: true }),
    ]);
    if (sourceEntries.length !== targetEntries.length) return false;
    const targetByName = new Map(targetEntries.map((entry) => [entry.name, entry]));
    for (const sourceEntry of sourceEntries) {
      const targetEntry = targetByName.get(sourceEntry.name);
      if (!targetEntry || sourceEntry.isDirectory() !== targetEntry.isDirectory() || sourceEntry.isFile() !== targetEntry.isFile()) {
        return false;
      }
      const sourcePath = path.join(source, sourceEntry.name);
      const targetPath = path.join(target, targetEntry.name);
      if (sourceEntry.isDirectory()) {
        if (!await directoriesEqual(sourcePath, targetPath)) return false;
      } else if (sourceEntry.isFile()) {
        if (!(await readFile(sourcePath)).equals(await readFile(targetPath))) return false;
      } else {
        return false;
      }
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function pathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedLeft = pathApi.resolve(left);
  const normalizedRight = pathApi.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export async function withFileLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another Team AI operation is already using ${lockPath}`);
    }
    throw error;
  }

  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
