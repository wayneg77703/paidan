// Installation persistence only. No endpoint knowledge and no command imports.
import * as path from 'node:path'
import { PaidanError } from './errors.js'
import { assertUnlinkedTarget, readOptionalBytes, fileDigest, writeApprovedFile } from './approved-write.js'

export interface InstallationFile {
    root: string; target: string; payload: string; before: string | null; kind: string; owner?: string
    entries?: Record<string, unknown>
}

export async function checkInstallationTarget(root: string, target: string) {
    try { await assertUnlinkedTarget(root, target) }
    catch (e) { throw new PaidanError('SETUP_UNSAFE_TARGET', e instanceof Error ? e.message : String(e), { target }) }
}

export async function installationFile(root: string, target: string, payload: string, kind: string, owner?: string): Promise<InstallationFile> {
    await checkInstallationTarget(root, target)
    const before = await readOptionalBytes(target)
    return { root, target, payload, kind, ...(owner ? { owner } : {}), before: before === null ? null : fileDigest(before) }
}

export async function readInstallationReceipt(configPath: string) {
    const target = path.join(path.dirname(configPath), 'install-receipt.json')
    await checkInstallationTarget(path.dirname(configPath), target)
    const raw = await readOptionalBytes(target)
    let value: Record<string, any> = { schema_version: 1, files: {} }
    if (raw) {
        try {
            value = JSON.parse(raw.toString('utf8'))
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || value.files !== undefined && (!value.files || typeof value.files !== 'object' || Array.isArray(value.files))) throw new Error()
            // Preserve older agent-written fields; only the program-owned files map is merged.
            value.files ??= {}
        } catch { throw new PaidanError('SETUP_RECEIPT_INVALID', '已有安装记录无法解析，已保留；请先核对，不会重新创建空记录。', { path: target }) }
    }
    return { target, before: raw === null ? null : fileDigest(raw), value }
}

export function previewFiles(files: InstallationFile[]) {
    return files.map(f => ({ kind: f.kind, path: f.target, action: f.before === fileDigest(f.payload) ? 'unchanged' : f.before === null ? 'create' : 'backup-and-update' }))
}

/** Record actual completed writes, including when a later file fails. No automatic rollback. */
export async function applyInstallationFiles(files: InstallationFile[], receipt: Awaited<ReturnType<typeof readInstallationReceipt>>, version: string) {
    const written: Array<Awaited<ReturnType<typeof writeApprovedFile>> & { kind: string; owner?: string }> = []
    let failure: unknown = null
    try {
        const current = await readOptionalBytes(receipt.target)
        if ((current === null ? null : fileDigest(current)) !== receipt.before) throw new Error('安装记录在预览后变化，请重新预览；尚未写入。')
        for (const f of files) {
            const result = await writeApprovedFile(f.root, f.target, f.payload, { expectedSha256: f.before })
            written.push({ kind: f.kind, ...(f.owner ? { owner: f.owner } : {}), ...result })
            const previous = receipt.value.files[f.target]
            receipt.value.files[f.target] = { kind: f.kind, ...(f.owner ? { owner: f.owner } : {}), sha256: fileDigest(f.payload),
                version, ...(result.backup ? { backup: result.backup } : previous?.backup ? { backup: previous.backup } : {}),
                ...(f.entries ? { entries: { ...previous?.entries, ...f.entries } } : {}) }
        }
    } catch (e) { failure = e }
    let record: Awaited<ReturnType<typeof writeApprovedFile>> | undefined
    if (written.length) {
        receipt.value.version = version
        try {
            record = await writeApprovedFile(path.dirname(receipt.target), receipt.target, JSON.stringify(receipt.value, null, 2) + '\n', { expectedSha256: receipt.before })
        } catch (e) {
            throw new PaidanError('SETUP_WRITE_FAILED', '部分文件已保存，但安装记录保存失败；请按 written 核对，不要重新手写记录。', { written, receipt: receipt.target, reason: e instanceof Error ? e.message : String(e) })
        }
    }
    if (failure) throw new PaidanError('SETUP_WRITE_FAILED', '保存未全部完成；已完成项已记录，原生配置副本可能已写入。请核对 written 和备份，不自动回滚。', { written, receipt: record, reason: failure instanceof Error ? failure.message : String(failure) })
    return { written, receipt: record }
}
