import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const FILE = '/usr/src/app/server/dist/controllers/assistant.controller.js';
const BAK = FILE + '.pre-agent-stream';
const HTML_FILE = '/tmp/agent-console.html';

// Always patch from a pristine baseline so re-runs are clean/idempotent.
if (!existsSync(BAK)) copyFileSync(FILE, BAK);
let src = readFileSync(BAK, 'utf8');

const html = readFileSync(HTML_FILE, 'utf8');

const methods = `
    agentConsole(res) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(AGENT_CONSOLE_HTML);
    }
    async agentStream(auth, body, res) {
        const bridgeUrl = process.env.IMMICH_ASSISTANT_AGENT_STREAM_URL || 'http://172.31.0.1:43737/agent-stream';
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const ac = new AbortController();
        res.on('close', () => ac.abort());
        try {
            const upstream = await fetch(bridgeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
                signal: ac.signal,
            });
            if (!upstream.ok || !upstream.body) {
                res.write('event: bridge_error\\ndata: ' + JSON.stringify({ error: 'assistant bridge status ' + upstream.status }) + '\\n\\n');
                res.end();
                return;
            }
            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) res.write(decoder.decode(value, { stream: true }));
            }
        } catch (e) {
            if (!res.writableEnded) {
                res.write('event: bridge_error\\ndata: ' + JSON.stringify({ error: String((e && e.message) || e) }) + '\\n\\n');
            }
        } finally {
            if (!res.writableEnded) res.end();
        }
    }
`;

const classCloseAnchor = '\n};\nexports.AssistantController = AssistantController;';
if (src.indexOf(classCloseAnchor) < 0) throw new Error('class-close anchor not found');
src = src.replace(classCloseAnchor, '\n' + methods + '};\nexports.AssistantController = AssistantController;');

const voidAnchor = 'exports.AssistantController = void 0;';
if (src.indexOf(voidAnchor) < 0) throw new Error('void anchor not found');
src = src.replace(voidAnchor, voidAnchor + '\nconst AGENT_CONSOLE_HTML = ' + JSON.stringify(html) + ';');

const decorators = `
__decorate([
    (0, common_1.Get)('agent-console'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AssistantController.prototype, "agentConsole", null);
__decorate([
    (0, common_1.Post)('agent-stream'),
    (0, auth_guard_1.Authenticated)({ permission: enum_1.Permission.AssetRead }),
    __param(0, (0, auth_guard_1.Auth)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AssistantController.prototype, "agentStream", null);
`;
src = src + decorators;

writeFileSync(FILE, src);
console.log('patched OK; new length', src.length, '; html bytes', html.length);
