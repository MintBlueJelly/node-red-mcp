// Configuration from the environment. A value that does not parse fails startup rather than falling
// back to a default, so a typo in a manifest shows up as a crashlooping pod, not as silent defaults.

function int(env, name, fallback, min = 1) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
    return value;
}

export function loadConfig(env = process.env) {
    const nodeRedUrl = env.NODE_RED_URL;
    if (!nodeRedUrl) throw new Error('NODE_RED_URL is required, e.g. http://nodered:1880');
    let protocol;
    try { ({ protocol } = new URL(nodeRedUrl)); } catch { /* reported below */ }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`NODE_RED_URL is not an http(s) URL: "${nodeRedUrl}"`);
    return {
        nodeRedUrl: nodeRedUrl.replace(/\/+$/, ''),
        nodeRedToken: env.NODE_RED_TOKEN || undefined,
        host: env.HOST || '0.0.0.0',
        port: int(env, 'PORT', 8080),
        requestTimeoutMs: int(env, 'NODE_RED_TIMEOUT_MS', 30000),
        heartbeatTimeoutMs: int(env, 'COMMS_HEARTBEAT_TIMEOUT_MS', 45000),
        debugBufferItems: int(env, 'DEBUG_BUFFER_ITEMS', 1000),
        debugBufferBytes: int(env, 'DEBUG_BUFFER_BYTES', 4 * 1024 * 1024),
        resultMaxChars: int(env, 'RESULT_MAX_CHARS', 40000, 1000),
        injectCooldownMs: int(env, 'INJECT_COOLDOWN_MS', 10000, 0),
    };
}
