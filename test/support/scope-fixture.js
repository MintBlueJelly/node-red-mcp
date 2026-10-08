// Flows where a change on one tab, subflow or config node restarts nodes elsewhere: a config node used
// by another config node, nested subflows, a config node used inside a subflow template, single-target
// link nodes across tabs, plus a function node that is not an inject node. Each tab has an On Start
// counter in the affected chain and one standing alone.

const counter = (name, extra = '') => ({
    func: 'return msg;',
    initialize: `global.set('start_${name}', (global.get('start_${name}') || 0) + 1);${extra}`,
    finalize: '',
    libs: [],
    noerr: 0,
    outputs: 1,
});
const tab = (id, label) => ({ id, type: 'tab', label, disabled: false, info: '', env: [] });
const fn = (id, z, name, wires = [[]], extra = '') => ({ id, type: 'function', z, name, ...counter(name, extra), x: 300, y: 100, wires });

export const SCOPE_COUNTERS = ['TB_chain', 'TB_alone', 'SFI', 'SFO', 'TN_chain', 'TN_alone', 'SFP', 'TP_chain', 'TP_alone',
    'TL1_chain', 'TL1_ret', 'TL2_up', 'TL2_alone', 'TL3_up', 'TL3_alone', 'TX_alone'];

export function scopeFlows() {
    return [
        // A config node used by another config node, used by a node on a tab.
        { id: 'T1', type: 'tls-config', name: 'tls1', cert: '', key: '', ca: '', certname: '', keyname: '', caname: '', servername: '', verifyservercert: true, alpnprotocol: '' },
        { id: 'M1', type: 'mqtt-broker', name: 'broker1', broker: '127.0.0.1', port: '1', tls: 'T1', clientid: '', autoConnect: false, usetls: false, protocolVersion: '4', keepalive: '60', cleansession: true, autoUnsubscribe: true, birthTopic: '', closeTopic: '', willTopic: '', userProps: '', sessionExpiry: '' },
        tab('TB', 'MQTT tab'),
        { id: 'TB_in', type: 'mqtt in', z: 'TB', name: 'mq in', topic: 'x', qos: '0', datatype: 'auto-detect', broker: 'M1', nl: false, rap: true, rh: 0, inputs: 0, x: 100, y: 100, wires: [['TB_chain']] },
        fn('TB_chain', 'TB', 'TB_chain'),
        fn('TB_alone', 'TB', 'TB_alone'),

        // Nested subflows; the inner node sets a red status.
        { id: 'SFI', type: 'subflow', name: 'Inner', info: '', category: '', in: [{ x: 50, y: 30, wires: [{ id: 'sfi_fn' }] }], out: [{ x: 300, y: 30, wires: [{ id: 'sfi_fn', port: 0 }] }], env: [], color: '#DDAA99' },
        fn('sfi_fn', 'SFI', 'SFI', [[]], "node.status({fill:'red',shape:'dot',text:'inner red'});"),
        { id: 'SFO', type: 'subflow', name: 'Outer', info: '', category: '', in: [{ x: 50, y: 30, wires: [{ id: 'sfo_inst' }] }], out: [{ x: 400, y: 30, wires: [{ id: 'sfo_inst', port: 0 }] }], env: [], color: '#DDAA99' },
        { id: 'sfo_inst', type: 'subflow:SFI', z: 'SFO', name: '', x: 200, y: 50, wires: [[]] },
        fn('sfo_fn', 'SFO', 'SFO'),
        tab('TN', 'Nested tab'),
        { id: 'TN_sf', type: 'subflow:SFO', z: 'TN', name: '', x: 100, y: 100, wires: [['TN_chain']] },
        fn('TN_chain', 'TN', 'TN_chain'),
        fn('TN_alone', 'TN', 'TN_alone'),

        // A global config node used inside a subflow template.
        { id: 'P1', type: 'http proxy', name: 'proxy1', url: 'http://proxy.invalid:3128', noproxy: [] },
        { id: 'SFP', type: 'subflow', name: 'Uses proxy', info: '', category: '', in: [{ x: 50, y: 30, wires: [{ id: 'sfp_http' }] }], out: [{ x: 400, y: 30, wires: [{ id: 'sfp_fn', port: 0 }] }], env: [], color: '#DDAA99' },
        { id: 'sfp_http', type: 'http request', z: 'SFP', name: 'via proxy', method: 'GET', ret: 'txt', paytoqs: 'ignore', url: 'http://example.invalid', tls: '', persist: false, proxy: 'P1', insecureHTTPParser: false, authType: '', senderr: false, headers: [], x: 200, y: 50, wires: [['sfp_fn']] },
        fn('sfp_fn', 'SFP', 'SFP'),
        tab('TP', 'Proxy tab'),
        { id: 'TP_sf', type: 'subflow:SFP', z: 'TP', name: '', x: 100, y: 100, wires: [['TP_chain']] },
        fn('TP_chain', 'TP', 'TP_chain'),
        fn('TP_alone', 'TP', 'TP_alone'),

        // Link nodes across tabs, each with a single target.
        tab('TL1', 'Link target'),
        { id: 'TL1_li', type: 'link in', z: 'TL1', name: 'target', links: ['TL2_lo'], x: 100, y: 100, wires: [['TL1_chain']] },
        fn('TL1_chain', 'TL1', 'TL1_chain'),
        { id: 'TL1_li2', type: 'link in', z: 'TL1', name: 'callee', links: [], x: 100, y: 200, wires: [['TL1_ret']] },
        fn('TL1_ret', 'TL1', 'TL1_ret', [['TL1_rlo']]),
        { id: 'TL1_rlo', type: 'link out', z: 'TL1', name: '', mode: 'return', links: [], x: 500, y: 200, wires: [] },
        tab('TL2', 'Link source'),
        fn('TL2_up', 'TL2', 'TL2_up', [['TL2_lo']]),
        { id: 'TL2_lo', type: 'link out', z: 'TL2', name: 'send', mode: 'link', links: ['TL1_li'], x: 500, y: 100, wires: [] },
        fn('TL2_alone', 'TL2', 'TL2_alone'),
        tab('TL3', 'Link caller'),
        fn('TL3_up', 'TL3', 'TL3_up', [['TL3_call']]),
        { id: 'TL3_call', type: 'link call', z: 'TL3', name: '', links: ['TL1_li2'], linkType: 'static', timeout: '30', x: 500, y: 100, wires: [[]] },
        fn('TL3_alone', 'TL3', 'TL3_alone'),

        // A node that is not an inject node.
        tab('TX', 'Inject target'),
        { id: 'TX_fn', type: 'function', z: 'TX', name: 'not an inject', func: "global.set('tx_hits', (global.get('tx_hits') || 0) + 1); return msg;", outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [], x: 300, y: 100, wires: [[]] },
        fn('TX_alone', 'TX', 'TX_alone'),
    ];
}
