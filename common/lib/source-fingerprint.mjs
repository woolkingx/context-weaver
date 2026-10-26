import { createHash } from 'node:crypto';

export function ownerManifest({
  fileSet = { files: [] }, policyInputs = {}, extraInputs = [], producerGeneration = 'v1',
} = {}) {
  const files = [...(fileSet.files ?? [])].map((file) => ({
    root_id: file.root_id ?? file.rootId,
    path: file.path ?? file.relativePath,
    mtimeMs: file.mtimeMs ?? null,
    size: file.size ?? null,
    sha256: file.sha256 ?? file.contentHash ?? null,
  })).sort((a, b) => `${a.root_id}\0${a.path}`.localeCompare(`${b.root_id}\0${b.path}`));
  const value = {
    producerGeneration, files, policyInputs, extraInputs,
  };
  const policyFingerprint = createHash('sha256').update(JSON.stringify(policyInputs)).digest('hex');
  return {
    ...value,
    admittedFileCount: files.length,
    fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    policyFingerprint,
  };
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
