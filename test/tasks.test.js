'use strict';
// Tasks (ticket 13): worktrees on real temporary git repositories, the store,
// the engine (with a fake launch) and the check of a task sent by the window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const i18n = require('../src/i18n');
const { git, repoRoot, findRepos, addWorktree, removeWorktree, summary } = require('../src/main/tasks/worktree');
const { TaskStore, slugOf } = require('../src/main/tasks/store');
const { TaskEngine } = require('../src/main/tasks/engine');
const { checkTask } = require('../src/main/tasks/check');
const { resolveAgents } = require('../src/main/agents');

i18n.setLanguage('en');

const GIT = 'git';
const POSIX = process.platform !== 'win32';
const hasGit = !spawnSync(GIT, ['--version']).error;
// Long, real paths (the CI's temporary folder is a Windows short name: RUNNER~1).
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aska-tasks-')));

/** A repository with one commit, in dir. */
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args) => assert.ok(git(GIT, args, dir).ok, args.join(' '));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "engines": { "node": ">=20" } }\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  return dir;
}

test('worktrees: own folder and branch, the working copy untouched, cleaned up', { skip: !hasGit && 'git not installed' }, () => {
  const root = tmp();
  const repo = makeRepo(path.join(root, 'app'));
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'work in progress of the user\n'); // not committed
  const dir = path.join(root, 'wt', '1');
  const w = addWorktree(GIT, { repo, dir, branch: 'aska/node-26/1' });
  assert.equal(w.branch, 'aska/node-26/1');
  assert.equal(w.dir, fs.realpathSync(dir));
  assert.ok(fs.existsSync(path.join(dir, 'package.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'wip.txt')), 'from the last commit, not the working copy');
  assert.equal(git(GIT, ['branch', '--show-current'], repo).out, 'main', 'the user stays on their branch');
  assert.ok(fs.existsSync(path.join(repo, 'wip.txt')));
  // Work in the worktree: a commit on its branch.
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "engines": { "node": ">=26" } }\n');
  assert.ok(git(GIT, ['-c', 'user.email=b@example.com', '-c', 'user.name=Bot', 'commit', '-qam', 'chore: node 26'], dir).ok);
  const sum = summary(GIT, { dir, base: w.base });
  assert.equal(sum.commits.length, 1);
  assert.match(sum.commits[0], /chore: node 26/);
  assert.match(sum.changes, /1 file changed/);
  assert.equal(sum.uncommitted, 0);
  // Refusals.
  assert.match(addWorktree(GIT, { repo, dir: path.join(root, 'wt', '2'), branch: 'aska/node-26/1' }).error, /already exists/);
  assert.match(addWorktree(GIT, { repo, dir: path.join(root, 'wt', '3'), branch: 'main' }).error, /Invalid branch/);
  assert.match(addWorktree(GIT, { repo: root, dir: path.join(root, 'wt', '4'), branch: 'aska/x/4' }).error, /not a git repository/);
  // Cleanup: the folder goes, the branch and its commit stay.
  assert.deepEqual(removeWorktree(GIT, { repo, dir }), { ok: true });
  assert.ok(!fs.existsSync(dir));
  assert.ok(git(GIT, ['rev-parse', '--verify', 'aska/node-26/1'], repo).ok, 'the branch is the result');
  assert.ok(!git(GIT, ['worktree', 'list'], repo).out.includes(path.join('wt', '1')));
});

test('worktrees: repositories of a folder', { skip: !hasGit && 'git not installed' }, () => {
  const root = tmp();
  makeRepo(path.join(root, 'api'));
  makeRepo(path.join(root, 'web'));
  makeRepo(path.join(root, 'services', 'billing'));
  makeRepo(path.join(root, 'deep', 'a', 'b')); // three levels: not searched
  fs.mkdirSync(path.join(root, 'notes'));
  fs.mkdirSync(path.join(root, 'node_modules', 'x', '.git'), { recursive: true });
  const found = findRepos(GIT, root).map((d) => path.relative(root, d)).sort();
  assert.deepEqual(found, ['api', path.join('services', 'billing'), 'web']);
  assert.equal(repoRoot(GIT, path.join(root, 'api')), path.join(root, 'api'));
});

test('task store: saved privately, an interrupted run is never resumed by itself', () => {
  const dir = path.join(tmp(), 'tasks');
  const store = new TaskStore(dir);
  assert.equal(slugOf('Passe toutes les apps à Node 26 !'), 'passe-toutes-les-apps-a-node-26');
  assert.equal(slugOf('???'), 'task');
  const task = store.create({ goal: 'Node 26', root: '/x', subtasks: [{ repo: '/x/a', botId: 'b', prompt: 'p', mode: 'edit', allow: [] }, { repo: '/x/b', botId: 'b', prompt: 'p', mode: 'edit', allow: [] }] });
  assert.match(task.id, /^[a-f0-9]{12}$/);
  assert.deepEqual(task.subtasks.map((s) => [s.n, s.status]), [[1, 'pending'], [2, 'pending']]);
  task.status = 'running';
  task.subtasks[0].status = 'running';
  task.subtasks[1].status = 'queued';
  store.save(task);
  if (POSIX) assert.equal(fs.statSync(path.join(dir, `${task.id}.json`)).mode & 0o777, 0o600);
  const again = new TaskStore(dir).load(task.id);
  assert.equal(again.status, 'stopped');
  assert.deepEqual(again.subtasks.map((s) => s.status), ['failed', 'cancelled']);
  assert.match(again.subtasks[0].error, /Interrupted/);
  assert.equal(store.list().length, 1);
  store.remove(task.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.load('../../etc'), null);
});

/** A launch whose runs end when the test says so. */
function fakeLaunch() {
  const runs = [];
  const launch = (task, s) => {
    let end;
    const done = new Promise((r) => {
      end = r;
    });
    const run = { task, s, end, cancel: () => end({ ok: false, reason: 'cancel', durationMs: 1 }) };
    runs.push(run);
    return { cancel: run.cancel, done };
  };
  return { runs, launch };
}
const tick = () => new Promise((r) => setImmediate(r));

test('task engine: one worktree each, the request limit shared, cancel, run again, clean up', { skip: !hasGit && 'git not installed' }, async () => {
  const root = tmp();
  const repos = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => makeRepo(path.join(root, 'repos', n)));
  const store = new TaskStore(path.join(root, 'state'));
  const { runs, launch } = fakeLaunch();
  let tabsBusy = 1; // one tab already working
  const updates = [];
  const engine = new TaskEngine({ store, gitBin: GIT, worktreesDir: path.join(root, 'wt'), launch, busy: () => tabsBusy, max: 4, onUpdate: (t) => updates.push(t.status) });
  const task = engine.add(store.create({ goal: 'Node 26', root, subtasks: repos.map((repo) => ({ repo, botId: 'b', prompt: 'p', mode: 'edit', allow: [] })) }));
  engine.start(task.id);
  assert.equal(engine.active, 3, '4 at most, one tab already working');
  assert.deepEqual(task.subtasks.map((s) => s.status), ['running', 'running', 'running', 'queued', 'queued', 'queued']);
  const s1 = task.subtasks[0];
  assert.equal(s1.branch, 'aska/node-26/1');
  assert.ok(fs.existsSync(s1.worktree));
  // A subtask ends: the next one starts.
  runs[0].end({ ok: true, durationMs: 5, answer: 'Done.' });
  await tick();
  assert.equal(s1.status, 'done');
  assert.equal(s1.answer, 'Done.');
  assert.deepEqual(s1.summary, { commits: [], changes: '', uncommitted: 0 });
  assert.equal(task.subtasks[3].status, 'running');
  // The tab finishes too: room for one more when the engine is pumped.
  tabsBusy = 0;
  engine.pump();
  assert.equal(task.subtasks[4].status, 'running');
  // Cancel one queued and one running.
  engine.cancel(task.id, 6);
  engine.cancel(task.id, 2);
  await tick();
  assert.equal(task.subtasks[5].status, 'cancelled');
  assert.equal(task.subtasks[1].status, 'cancelled');
  // A failure, then started again: same worktree, same branch.
  runs[2].end({ ok: false, reason: 'exit', code: 1, error: 'tests failed', durationMs: 3 });
  await tick();
  assert.equal(task.subtasks[2].status, 'failed');
  assert.equal(task.subtasks[2].error, 'tests failed');
  const firstWorktree = task.subtasks[2].worktree;
  engine.start(task.id, [3]);
  assert.equal(task.subtasks[2].status, 'running');
  assert.equal(task.subtasks[2].worktree, firstWorktree);
  // Not cleaned while running; then everything ends and it is cleaned.
  assert.match(engine.cleanup(task.id).error, /still running/);
  for (const r of runs.slice(3)) r.end({ ok: true, durationMs: 1, answer: '' });
  await tick();
  assert.equal(task.status, 'done');
  assert.ok(updates.length > 5);
  assert.deepEqual(engine.cleanup(task.id), { ok: true });
  for (const s of task.subtasks) if (s.worktree) assert.ok(!fs.existsSync(s.worktree));
  assert.equal(engine.list().length, 0);
  assert.ok(git(GIT, ['rev-parse', '--verify', 'aska/node-26/1'], repos[0]).ok, 'branches kept');
});

test('task engine: a repository that cannot get its worktree fails alone', { skip: !hasGit && 'git not installed' }, async () => {
  const root = tmp();
  const good = makeRepo(path.join(root, 'good'));
  const store = new TaskStore(path.join(root, 'state'));
  const { runs, launch } = fakeLaunch();
  const engine = new TaskEngine({ store, gitBin: GIT, worktreesDir: path.join(root, 'wt'), launch });
  const task = engine.add(store.create({ goal: 'x', root, subtasks: [{ repo: path.join(root, 'nope'), botId: 'b', prompt: 'p', mode: 'edit', allow: [] }, { repo: good, botId: 'b', prompt: 'p', mode: 'edit', allow: [] }] }));
  engine.start(task.id);
  assert.equal(task.subtasks[0].status, 'failed');
  assert.match(task.subtasks[0].error, /not a git repository/);
  assert.equal(task.subtasks[1].status, 'running');
  runs[0].end({ ok: true, durationMs: 1 });
  await tick();
  assert.equal(task.status, 'done');
});

test('task check: repositories of the folder, known bots, modes up to their ceiling', { skip: !hasGit && 'git not installed' }, () => {
  const root = tmp();
  const repo = makeRepo(path.join(root, 'app'));
  const other = makeRepo(path.join(tmp(), 'elsewhere'));
  const { agents } = resolveAgents({});
  for (const a of Object.values(agents)) a.binPath = '/bin/' + a.id; // as if installed
  const bots = {
    up: { id: 'up', label: 'Updater', agent: 'claude', maxMode: 'edit', allow: ['git add', 'git commit', 'git push'] },
    reader: { id: 'reader', label: 'Reader', agent: 'claude', maxMode: 'read', allow: [] },
  };
  const deps = { bots, agents, gitBin: GIT, home: os.homedir() };
  const ok = checkTask({ goal: ' Node 26 ', root, subtasks: [{ repo: path.join(repo, 'sub', '..'), botId: 'up', prompt: 'Update' }, { repo, botId: 'reader', prompt: 'Audit' }] }, deps);
  assert.equal(ok.goal, 'Node 26');
  assert.equal(ok.root, root);
  assert.deepEqual(ok.subtasks.map((s) => [s.repo, s.botId, s.mode]), [[repo, 'up', 'edit'], [repo, 'reader', 'read']]);
  assert.deepEqual(ok.subtasks[0].allow, ['git add', 'git commit', 'git push'], 'approving the task grants the bot its commands');
  const bad = (input, re) => assert.match(checkTask({ goal: 'x', root, ...input }, deps).error, re);
  bad({ subtasks: [{ repo: other, botId: 'up', prompt: 'p' }] }, /not a git repository of the chosen folder/);
  bad({ subtasks: [{ repo: path.join(root), botId: 'up', prompt: 'p' }] }, /not a git repository of the chosen folder/);
  bad({ subtasks: [{ repo, botId: 'nope', prompt: 'p' }] }, /unknown bot/);
  bad({ subtasks: [{ repo, botId: 'reader', prompt: 'p', mode: 'edit' }] }, /a mode up to "read"/);
  bad({ subtasks: [{ repo, botId: 'up', prompt: 'p', mode: 'auto' }] }, /a mode up to "edit"/);
  bad({ subtasks: [{ repo, botId: 'up', prompt: '' }] }, /an instruction/);
  bad({ subtasks: [] }, /From 1 to 20/);
  bad({ subtasks: Array.from({ length: 21 }, () => ({ repo, botId: 'up', prompt: 'p' })) }, /From 1 to 20/);
  assert.match(checkTask({ goal: '', root, subtasks: [] }, deps).error, /Describe the task/);
  assert.match(checkTask({ goal: 'x', root: 'relative', subtasks: [] }, deps).error, /Choose the folder/);
});
