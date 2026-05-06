/**
 * Returns true if the relative path should be excluded from sync.
 *
 * Pattern rules:
 *   - No slash: matches any path segment by name, e.g. ".playwright-mcp" or "*.log"
 *   - With slash: matches a path prefix, e.g. "dist/" or "build/temp"
 *   - "*" is supported as a wildcard within a segment
 */
export function isIgnored(rel: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    const segments = rel.split('/');
    return patterns.some(pattern => {
        if (pattern.includes('/')) {
            const prefix = pattern.endsWith('/') ? pattern : pattern + '/';
            return rel === pattern || rel.startsWith(prefix);
        }
        return segments.some(seg => matchSegment(seg, pattern));
    });
}

function matchSegment(seg: string, pattern: string): boolean {
    if (!pattern.includes('*')) return seg === pattern;
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(seg);
}
