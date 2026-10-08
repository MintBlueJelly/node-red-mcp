// A small flow set exercising every structure the write path has to preserve: tab env with a
// credential, a locked and a disabled tab, a subflow with an instance, a global config node with
// credentials, the global-config node, link nodes across tabs, a group and a junction. Each tab has an
// On Start counter wired into its chain and one standing alone, so a test can see what restarted.

const counter = (name) => ({
    func: 'return msg;',
    initialize: `global.set('start_${name}', (global.get('start_${name}') || 0) + 1);`,
    finalize: '',
    libs: [],
    noerr: 0,
    outputs: 1,
});

export const INSTALLED_TYPES = ['comment', 'debug', 'function', 'global-config', 'http proxy', 'http request', 'inject',
    'junction', 'link call', 'link in', 'link out'];

export function fixtureFlows() {
    return [
        { id: 'gc', type: 'global-config', env: [{ name: 'G_ENV', value: 'g1', type: 'str' }], modules: {} },
        { id: 'px1', type: 'http proxy', name: 'proxy1', url: 'http://proxy.invalid:3128', noproxy: [], credentials: { username: 'u', password: 'p' } },
        {
            id: 'A', type: 'tab', label: 'Tab A', disabled: false, info: 'info A',
            env: [{ name: 'A_ENV', value: 'a1', type: 'str' }, { name: 'A_SECRET', value: '', type: 'cred' }],
            credentials: { A_SECRET: 's3cret' },
        },
        { id: 'B', type: 'tab', label: 'Tab B', disabled: false, info: '', env: [] },
        { id: 'C', type: 'tab', label: 'Tab C', disabled: false, info: '', env: [] },
        { id: 'D', type: 'tab', label: 'Tab D', disabled: true, info: '', env: [] },
        { id: 'E', type: 'tab', label: 'Tab E', disabled: false, info: '', env: [], locked: true },
        { id: 'SF1', type: 'subflow', name: 'Sub 1', info: '', category: '', in: [{ x: 50, y: 30, wires: [{ id: 'sf1fn' }] }], out: [], env: [], color: '#DDAA99' },
        { id: 'sf1fn', type: 'function', z: 'SF1', name: 'sf fn', ...counter('SF1'), x: 200, y: 50, wires: [[]] },

        { id: 'A_alone', type: 'function', z: 'A', name: 'counter A alone', ...counter('A_alone'), g: 'A_grp', x: 100, y: 40, wires: [[]] },
        { id: 'A_inj', type: 'inject', z: 'A', name: 'probe', props: [{ p: 'payload' }], repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: '', payload: '', payloadType: 'date', x: 100, y: 100, wires: [['A_env']] },
        {
            id: 'A_env', type: 'function', z: 'A', name: 'read env', outputs: 1, x: 300, y: 100, wires: [['A_dbg', 'A_lo', 'A_j']],
            func: "global.set('a_env', env.get('A_ENV')); global.set('a_secret', env.get('A_SECRET')); global.set('g_env', env.get('G_ENV')); node.warn('probe warning'); node.status({fill:'red',shape:'ring',text:'probed'}); return msg;",
        },
        { id: 'A_dbg', type: 'debug', z: 'A', name: 'dbg A', active: true, tosidebar: true, console: false, tostatus: false, complete: 'payload', targetType: 'msg', x: 500, y: 100, wires: [] },
        { id: 'A_chain', type: 'function', z: 'A', name: 'counter A chain', ...counter('A_chain'), x: 500, y: 220, wires: [[]] },
        { id: 'A_j', type: 'junction', z: 'A', x: 400, y: 220, wires: [['A_chain']] },
        { id: 'A_lo', type: 'link out', z: 'A', name: 'to B', mode: 'link', links: ['B_li'], x: 500, y: 160, wires: [] },
        { id: 'A_grp', type: 'group', z: 'A', name: 'grp', style: {}, nodes: ['A_alone'], x: 74, y: 19, w: 152, h: 42 },

        { id: 'B_alone', type: 'function', z: 'B', name: 'counter B alone', ...counter('B_alone'), x: 100, y: 40, wires: [[]] },
        { id: 'B_li', type: 'link in', z: 'B', name: 'from A', links: ['A_lo'], x: 100, y: 100, wires: [[]] },
        { id: 'B_http', type: 'http request', z: 'B', name: 'via proxy', method: 'GET', ret: 'txt', paytoqs: 'ignore', url: 'http://example.invalid', tls: '', persist: false, proxy: 'px1', insecureHTTPParser: false, authType: '', senderr: false, headers: [], x: 300, y: 160, wires: [['B_chain']] },
        { id: 'B_chain', type: 'function', z: 'B', name: 'counter B chain', ...counter('B_chain'), x: 500, y: 160, wires: [[]] },

        { id: 'C_alone', type: 'function', z: 'C', name: 'counter C alone', ...counter('C_alone'), x: 100, y: 40, wires: [[]] },
        { id: 'C_sf', type: 'subflow:SF1', z: 'C', name: '', x: 100, y: 100, wires: [] },

        { id: 'D_alone', type: 'function', z: 'D', name: 'counter D alone', ...counter('D_alone'), x: 100, y: 40, wires: [[]] },
        { id: 'E_alone', type: 'function', z: 'E', name: 'counter E alone', ...counter('E_alone'), x: 100, y: 40, wires: [[]] },
    ];
}

/** The fixture as Node-RED returns it from `GET /flows`: credentials are never included. */
export function storedFixture() {
    return fixtureFlows().map(({ credentials, ...rest }) => rest);
}

export const COUNTERS = ['A_alone', 'A_chain', 'B_alone', 'B_chain', 'C_alone', 'E_alone', 'SF1'];
