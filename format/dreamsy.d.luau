-- Dreamsy Luau API: typed declarations (Luau definition file) for format/LUAU_API.md.
--
-- The C++ engine type-checks every game script against this before it runs (`dreamsy-tool check`), and the
-- harness can show it to the model. Change it together with LUAU_API.md and engine-web/core/prelude.ts.
--
-- The Entity class's catalog props are generated from format/catalog.json at build time: the line
-- `--@ENTITY_PROPS` below is replaced with one typed field per catalog prop. Run
-- `dreamsy-tool check --print-defs` to see the complete file.
--
-- Typing rules: values the engine accepts in several forms (colors as Color or "#rrggbb", entity props as
-- Entity or id) are `any`; everything with a single form is typed exactly.

declare extern type Vec2 with
	x: number
	y: number
	function length(self): number
	function normalized(self): Vec2
	function dot(self, other: Vec2): number
	function lerp(self, other: Vec2, t: number): Vec2
	function distance(self, other: Vec2): number
	function __add(self, other: Vec2): Vec2
	function __sub(self, other: Vec2): Vec2
	function __mul(self, other: Vec2 | number): Vec2
	function __div(self, other: Vec2 | number): Vec2
	function __unm(self): Vec2
end

declare extern type Vec3 with
	x: number
	y: number
	z: number
	function length(self): number
	function normalized(self): Vec3
	function dot(self, other: Vec3): number
	function cross(self, other: Vec3): Vec3
	function lerp(self, other: Vec3, t: number): Vec3
	function distance(self, other: Vec3): number
	function __add(self, other: Vec3): Vec3
	function __sub(self, other: Vec3): Vec3
	function __mul(self, other: Vec3 | number): Vec3
	function __div(self, other: Vec3 | number): Vec3
	function __unm(self): Vec3
end

declare extern type Color with
	r: number
	g: number
	b: number
	a: number
	function toHex(self): string
	function lerp(self, other: Color, t: number): Color
end

declare extern type Connection with
	connected: boolean
	function disconnect(self): ()
	function Disconnect(self): ()
end

declare extern type Timer with
	function cancel(self): ()
	function Cancel(self): ()
end

-- Signals: connect(fn) returns a Connection. Arguments are typed loosely (`...any`) because the same
-- class serves every signal; the docs in LUAU_API.md give each signal's arguments.
declare extern type Signal with
	function connect(self, fn: (...any) -> ...any): Connection
	function Connect(self, fn: (...any) -> ...any): Connection
end

declare extern type Tween with
	done: Signal
	function cancel(self): ()
end

declare extern type Dialog with
	done: Signal
	function close(self): ()
end

declare extern type Player with
	id: string
	name: string
	team: string?
	isLocal: boolean
	isHost: boolean
	avatar: Entity?
end

declare extern type Entity with
	id: string
	type: string
	name: string
	parent: Entity?
	destroyed: boolean
	velocity: Vec2
	onFloor: boolean
	cols: number
	rows: number
	particleCount: number

	function children(self): { Entity }
	function hasTag(self, tag: string): boolean
	function addTag(self, tag: string): ()
	function removeTag(self, tag: string): ()
	function destroy(self): ()
	function clone(self, parent: Entity?): Entity
	function applyImpulse(self, impulse: Vec2): ()
	function play(self, name: string, restart: boolean?): ()
	function stop(self): ()
	function burst(self, n: number?): ()
	function clearParticles(self): ()
	function tileAt(self, worldPos: Vec2): string?
	function tagsAt(self, worldPos: Vec2): { string }
	function getTile(self, col: number, row: number): string?
	function setTile(self, col: number, row: number, char: string?): ()
	function worldToCell(self, worldPos: Vec2): (number, number)
	function cellToWorld(self, col: number, row: number): Vec2
	function isSolid(self, col: number, row: number): boolean
	function tileDef(self, char: string): { char: string, solid: boolean, tags: { string }, sprite: string?, color: string? }?

	bodyEntered: Signal
	bodyExited: Signal
	pressed: Signal
	tapped: Signal
	tappedAt: Signal
	tileTouched: Signal
	tileTapped: Signal
	animFinished: Signal

	--@ENTITY_PROPS
end

declare extern type RemoteEvent with
	function fireServer(self, ...: any): ()
	function fireClient(self, player: Player, ...: any): ()
	function fireAll(self, ...: any): ()
	function onServer(self, fn: (Player, ...any) -> ()): ()
	function onClient(self, fn: (...any) -> ()): ()
end

declare extern type RemoteFunction with
	function invoke(self, ...: any): ...any
	function onInvoke(self, fn: (Player, ...any) -> ...any): ()
end

-- ---------------------------------------------------------------- globals

-- script.entity is the owning entity of an attached script (nil only in unattached session scripts and
-- modules, which rarely touch it); typed non-optional so attached scripts don't need nil checks.
declare script: { entity: Entity, path: string }

declare function vec2(x: number?, y: number?): Vec2
declare function vec3(x: number?, y: number?, z: number?): Vec3
declare function color(hex: string): Color
declare function entity(id: string): Entity?
declare function entitiesTagged(tag: string): { Entity }
declare function isEntity(v: any): boolean
declare function spawn(typeName: string, props: { [string]: any }?, parent: Entity?): Entity
declare function onTick(fn: (dt: number) -> ()): Connection
declare function after(seconds: number, fn: () -> ()): Timer
declare function every(seconds: number, fn: () -> ()): Timer
declare function random(min: number?, max: number?): number
declare function time(): number
declare function warn(...: any): ()
declare function tween(e: Entity, props: { [string]: any }, seconds: number, opts: (string | { easing: string?, delay: number?, loop: boolean?, yoyo: boolean? })?): Tween
declare function loadScene(path: string, params: { [string]: any }?): ()
declare function sceneParams(): { [string]: any }
declare function currentScene(): string
declare function remoteEvent(name: string): RemoteEvent
declare function remoteFunction(name: string): RemoteFunction

declare screen: { size: () -> Vec2 }
declare clock: { now: () -> number }

declare camera: {
	shake: (intensity: number, seconds: number?) -> (),
	zoomTo: (zoom: number, seconds: number?, easing: string?) -> Tween,
	current: () -> Entity?,
	center: () -> Vec2,
	snap: () -> (),
	viewSize: () -> Vec2,
	screenToWorld: (p: Vec2) -> Vec2,
	worldToScreen: (p: Vec2) -> Vec2,
}

declare input: {
	axis: (name: string) -> number,
	pressed: (name: string) -> boolean,
	held: (name: string) -> boolean,
	pointer: () -> Vec2?,
	pointerDown: Signal,
	pointerUp: Signal,
	swipe: Signal,
}

declare ui: {
	toast: (text: any, seconds: number?) -> (),
	showScreen: (rootEntityId: string) -> (),
	hideScreen: (rootEntityId: string) -> (),
	theme: () -> { primary: string, accent: string, background: string, text: string, panel: string, font: string },
	dialog: (lines: any, opts: { [string]: any }?) -> Dialog,
	choice: (prompt: any, options: { string }, fn: ((index: number) -> ())?, opts: { [string]: any }?) -> Dialog,
	dialogOpen: () -> boolean,
}

declare save: {
	get: (key: string, default: any?) -> any,
	set: (key: string, value: any) -> (),
	remove: (key: string) -> (),
	keys: () -> { string },
}

declare data: {
	list: (dir: string) -> { string },
	read: (path: string) -> any,
	exists: (path: string) -> boolean,
	player: (p: Player) -> { [string]: any },
	world: () -> { [string]: any },
}

declare files: {
	list: (dir: string) -> { string },
	read: (path: string) -> any,
	exists: (path: string) -> boolean,
}

declare game: {
	timeScale: number,
	session: (fn: () -> ()) -> (),
	sceneLoaded: Signal,
	paused: Signal,
	resumed: Signal,
	restartRequested: Signal,
}

declare players: {
	all: () -> { Player },
	get: (id: string) -> Player?,
	onTeam: (team: string) -> { Player },
	fromEntity: (e: Entity) -> Player?,
	joined: Signal,
	left: Signal,
	[string]: Player?, -- players["local"] (local is a keyword)
}

declare room: {
	active: boolean,
	code: string?,
	mode: string?,
	max: number,
	min: number,
	isHost: boolean,
	isSpectator: boolean,
	spectators: number,
	match: number,
	seed: number,
	host: () -> Player,
	replicate: (e: Entity, opts: { tint: boolean? }?) -> (),
	setState: (key: string, value: any) -> (),
	state: (key: string) -> any,
	addScore: (target: any, n: number) -> (),
	score: (target: any) -> number,
	scores: () -> { [string]: number },
	finish: (winner: any) -> (),
	teamColor: (team: string) -> Color,
	stateChanged: Signal,
	scoreChanged: Signal,
	ended: Signal,
	avatarSpawned: Signal,
}

declare sfx: { play: (id: string, opts: { volume: number?, pitch: number? }?) -> () }
declare music: { play: (id: string, opts: { fade: number? }?) -> (), stop: (fade: number?) -> () }
declare sound: { play: (assetId: string, at: any?) -> () }
declare settings: { get: (name: string) -> any }

declare store: {
	items: () -> { { id: string, kind: string, name: string, description: string, price: number, icon: string? } },
	owns: (itemId: string) -> boolean,
	prompt: (itemId: string) -> (),
	pending: () -> { { itemId: string, purchaseId: string } },
	consume: (purchaseId: string) -> (),
	purchased: Signal,
}

declare leaderboard: {
	start: (board: string?, opts: { track: Entity? }?) -> (),
	finish: (board: string?) -> number?,
	cancel: (board: string?) -> (),
	elapsed: (board: string?) -> number,
	running: (board: string?) -> boolean,
	submit: (board: string, value: number, opts: { order: string? }?) -> (),
	raceGhost: (which: any, board: string?) -> (),
	result: Signal,
}

declare platform: { runEnded: (reason: string?) -> () }
