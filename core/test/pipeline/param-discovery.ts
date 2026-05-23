/**
 * Auto-discovers fetchRaw* methods and their param types from exchange
 * fetcher source files and BaseExchange.ts interface definitions.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ParamField {
    name: string;
    type: string;
}

export interface DiscoveredMethod {
    exchange: string;
    method: string;
    paramType: string;
    fields: ParamField[];
    argPattern: 'params-only' | 'id-params' | 'params-wallet' | 'id-params-extra';
}

function parseInterfaces(source: string): Map<string, ParamField[]> {
    const result = new Map<string, ParamField[]>();
    const re = /export\s+interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?\s*\{/g;

    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const name = match[1];
        const startBrace = match.index + match[0].length - 1;
        let depth = 1;
        let pos = startBrace + 1;
        while (pos < source.length && depth > 0) {
            if (source[pos] === '{') depth++;
            if (source[pos] === '}') depth--;
            pos++;
        }
        const body = source.slice(startBrace + 1, pos - 1);
        result.set(name, parseFieldsFromBody(body));
    }
    return result;
}

function parseExtends(source: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const re = /export\s+interface\s+(\w+)\s+extends\s+([\w,\s]+)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        result.set(match[1], match[2].split(',').map((s) => s.trim()).filter(Boolean));
    }
    return result;
}

function parseFieldsFromBody(body: string): ParamField[] {
    const fields: ParamField[] = [];
    const stripped = body.replace(/\/\*\*[\s\S]*?\*\//g, '');
    const re = /^\s*(\w+)\??\s*:\s*([^;/\n]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
        fields.push({ name: m[1], type: normalizeType(m[2].trim()) });
    }
    return fields;
}

function normalizeType(raw: string): string {
    if (/^'[^']*'(\s*\|\s*'[^']*')*$/.test(raw)) return 'string';
    if (raw === 'CandleInterval') return 'string';
    return raw;
}

function resolveFields(
    name: string,
    ownFields: Map<string, ParamField[]>,
    extendsMap: Map<string, string[]>,
    visited: Set<string> = new Set(),
): ParamField[] {
    if (visited.has(name)) return [];
    visited.add(name);

    const own = ownFields.get(name) ?? [];
    const parents = extendsMap.get(name) ?? [];
    const inherited: ParamField[] = [];
    for (const parent of parents) {
        inherited.push(...resolveFields(parent, ownFields, extendsMap, visited));
    }

    const byName = new Map<string, ParamField>();
    for (const f of inherited) byName.set(f.name, f);
    for (const f of own) byName.set(f.name, f);
    return Array.from(byName.values());
}

function parseMethodSignatures(source: string): { method: string; paramType: string; argPattern: DiscoveredMethod['argPattern'] }[] {
    const results: { method: string; paramType: string; argPattern: DiscoveredMethod['argPattern'] }[] = [];
    const methodRe = /(?:^|\n)\s+async\s+(fetchRaw\w+)\s*\(/g;

    let match: RegExpExecArray | null;
    while ((match = methodRe.exec(source)) !== null) {
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const prefix = source.slice(lineStart, match.index + match[0].length);
        if (/private\s+async\s+fetchRaw/.test(prefix)) continue;

        const argsStart = match.index + match[0].length;
        let depth = 1;
        let pos = argsStart;
        while (pos < source.length && depth > 0) {
            if (source[pos] === '(') depth++;
            if (source[pos] === ')') depth--;
            pos++;
        }

        const argsBody = source.slice(argsStart, pos - 1);
        const args = splitArgs(argsBody);

        let paramIdx = -1;
        let paramType = '';
        for (let i = 0; i < args.length; i++) {
            const argMatch = args[i].trim().match(/^_?(\w+)\??\s*:\s*(.+)$/s);
            if (!argMatch) continue;
            const typeName = argMatch[2].trim();
            if (/^Record\s*</.test(typeName) || /^\{/.test(typeName)) continue;
            if (/^\w+Params$/.test(typeName)) {
                paramIdx = i;
                paramType = typeName;
                break;
            }
        }

        if (paramIdx === -1) continue;

        let argPattern: DiscoveredMethod['argPattern'];
        if (args.length === 1 && paramIdx === 0) argPattern = 'params-only';
        else if (args.length === 2 && paramIdx === 1) argPattern = 'id-params';
        else if (args.length === 2 && paramIdx === 0) argPattern = 'params-wallet';
        else argPattern = 'id-params-extra';

        results.push({ method: match[1], paramType, argPattern });
    }
    return results;
}

function splitArgs(argsBody: string): string[] {
    const result: string[] = [];
    let current = '';
    let angle = 0;
    let brace = 0;
    for (const ch of argsBody) {
        if (ch === '<') angle++;
        if (ch === '>') angle--;
        if (ch === '{') brace++;
        if (ch === '}') brace--;
        if (ch === ',' && angle === 0 && brace === 0) {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) result.push(current);
    return result;
}

export function discoverTestMatrix(coreDir: string): DiscoveredMethod[] {
    const baseSource = fs.readFileSync(path.join(coreDir, 'BaseExchange.ts'), 'utf-8');
    const ownFields = parseInterfaces(baseSource);
    const extendsMap = parseExtends(baseSource);

    const resolvedFields = new Map<string, ParamField[]>();
    for (const name of ownFields.keys()) {
        resolvedFields.set(name, resolveFields(name, ownFields, extendsMap));
    }

    const exchangesDir = path.join(coreDir, 'exchanges');
    const exchangeDirs = fs.readdirSync(exchangesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

    const discovered: DiscoveredMethod[] = [];

    for (const exchangeName of exchangeDirs) {
        const fetcherPath = path.join(exchangesDir, exchangeName, 'fetcher.ts');
        if (!fs.existsSync(fetcherPath)) continue;

        const fetcherSource = fs.readFileSync(fetcherPath, 'utf-8');
        for (const sig of parseMethodSignatures(fetcherSource)) {
            const fields = resolvedFields.get(sig.paramType);
            if (!fields) continue;

            discovered.push({
                exchange: exchangeName,
                method: sig.method,
                paramType: sig.paramType,
                fields,
                argPattern: sig.argPattern,
            });
        }
    }

    return discovered;
}
