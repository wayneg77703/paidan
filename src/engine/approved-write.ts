// Small shared writer for explicitly selected setup files and host skills.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

export const fileDigest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

export async function readOptionalBytes(file: string): Promise<Buffer | null> {
    try { return await fs.readFile(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** Check only the selected root and its descendants; unrelated OS ancestors may be links. */
export async function assertUnlinkedTarget(root: string, target: string): Promise<void> {
    root = path.resolve(root)
    const relative = path.relative(root, path.resolve(target))
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error('file target must be inside the selected directory')
    }
    for (let item = path.resolve(target); ; item = path.dirname(item)) {
        const stat = await fs.lstat(item).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
        })
        if (stat?.isSymbolicLink()) throw new Error(`file target traverses a link; inspect the actual destination first: ${item}`)
        if (stat && item === path.resolve(target) && !stat.isFile()) throw new Error(`file target is not a regular file: ${item}`)
        if (path.relative(root, item) === '') break // Windows paths may differ only in casing.
        if (path.dirname(item) === item) throw new Error('file target ancestry did not reach the selected directory')
    }
}

export async function writeApprovedFile(
    root: string, target: string, payload: string,
    opts: { expectedSha256?: string | null; label?: string } = {},
): Promise<{ path: string; status: 'created' | 'updated' | 'unchanged'; backup?: string }> {
    await assertUnlinkedTarget(root, target)
    const existing = await readOptionalBytes(target)
    if (existing?.equals(Buffer.from(payload))) return { path: target, status: 'unchanged' }
    if (existing && fileDigest(existing) !== opts.expectedSha256) {
        throw new Error(`existing ${opts.label ?? 'file'} differs; preserve it and review the changes before replacing: ${target}`)
    }
    if (!existing && opts.expectedSha256) throw new Error('file disappeared since review; review the current state again')
    await fs.mkdir(path.dirname(target), { recursive: true })
    let backup: string | undefined
    if (existing) {
        backup = `${target}.bak-${randomUUID()}`
        await fs.copyFile(target, backup, constants.COPYFILE_EXCL)
        if (!(await fs.readFile(backup)).equals(existing)) throw new Error('file changed while backing up; target preserved')
    }
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    await fs.writeFile(tmp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
        await assertUnlinkedTarget(root, target)
        if (existing) {
            if (!(await fs.readFile(target)).equals(existing)) throw new Error('file changed during installation; refusing to replace it')
            await fs.rename(tmp, target)
        } else {
            await fs.link(tmp, target) // exclusive publication, never replace a competing new file
            await fs.rm(tmp)
        }
    } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw error
    }
    return { path: target, status: existing ? 'updated' : 'created', ...(backup ? { backup } : {}) }
}
