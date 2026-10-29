/** Keep previews in the source's owned storage scope, including pilot retention. */
export function previewAssetPrefix(sourcePath: string, jobId: string, token: string) {
  const match = sourcePath.match(/^(\/[^/]+\/.+\/printscope\/(?:development|production)(?:\/pilots\/[^/]+)?)\/(?:originals|automation)\//);
  if (!match || !/^[a-f0-9-]{36}$/i.test(jobId) || !/^[a-f0-9-]{36}$/i.test(token)) throw new Error("SOURCE_SCOPE");
  return `${match[1]}/plates/${jobId}/${token}/`;
}
