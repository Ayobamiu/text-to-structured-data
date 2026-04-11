import dns from 'dns';
import { URL } from 'url';

// Prefer IPv4 for all lookups in this process (helps some Node/pg combos)
dns.setDefaultResultOrder('ipv4first');

function isIPv4Host(hostname) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function shouldResolveToIpv4(hostname) {
    if (process.env.DATABASE_FORCE_IPV4 === 'false' || process.env.DATABASE_FORCE_IPV4 === '0') {
        return false;
    }
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
        return false;
    }
    if (isIPv4Host(hostname)) {
        return false;
    }
    if (hostname.startsWith('[')) {
        return false;
    }
    return true;
}

function sslConfigForHost(hostname, searchParams) {
    const mode = searchParams.get('sslmode');
    if (mode === 'disable') {
        return false;
    }
    if (
        mode === 'require' ||
        mode === 'verify-full' ||
        mode === 'verify-ca' ||
        mode === 'prefer' ||
        hostname.includes('supabase.co')
    ) {
        return { rejectUnauthorized: true, servername: hostname };
    }
    return undefined;
}

/**
 * Resolve DATABASE_URL into node-pg Pool config.
 * Railway (and similar) can get ENETUNREACH on IPv6 to Supabase; resolving A record + TLS SNI fixes it.
 */
export async function resolvePgPoolConfig(connectionString, extraPoolOptions = {}) {
    const base = {
        connectionString,
        family: 4,
        ...extraPoolOptions,
    };

    if (!connectionString || !/^postgres(ql)?:/i.test(connectionString)) {
        return base;
    }

    let u;
    try {
        u = new URL(connectionString);
    } catch {
        return base;
    }

    const hostname = u.hostname;
    if (!shouldResolveToIpv4(hostname)) {
        return base;
    }

    try {
        const { address } = await dns.promises.lookup(hostname, { family: 4 });
        const user = decodeURIComponent(u.username || '');
        const password = decodeURIComponent(u.password || '');
        const database = (u.pathname || '').replace(/^\//, '') || 'postgres';
        const port = u.port ? parseInt(u.port, 10) : 5432;
        const ssl = sslConfigForHost(hostname, u.searchParams);

        const config = {
            host: address,
            port,
            user,
            password,
            database,
            family: 4,
            ...extraPoolOptions,
        };
        if (ssl !== undefined) {
            config.ssl = ssl;
        }
        console.log(`🔧 Postgres: resolved ${hostname} → ${address} (IPv4 + TLS SNI)`);
        return config;
    } catch (e) {
        console.warn('⚠️ Postgres IPv4 resolution skipped:', e.message);
        return base;
    }
}
