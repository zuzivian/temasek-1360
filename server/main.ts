// Run the game server locally: node server/main.ts [port]
// Then open http://localhost:<port>/?server to play through it (build first: npm run build).
import { startGameServer } from './game-server.ts';

const port = Number(process.argv[2] ?? 8080);
const srv = await startGameServer({ port, staticRoot: process.cwd(), log: line => console.error(line) });
console.log(`Temasek 1360 server on http://localhost:${srv.port}/?server (ticking every 600 ms)`);
