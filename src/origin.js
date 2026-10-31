// URL.port omits default ports even when they were explicit in the source URL.
export function effectivePort(url) {
  return url.port || ({ 'http:': '80', 'https:': '443' }[url.protocol] ?? '');
}
