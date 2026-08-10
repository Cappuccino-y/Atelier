extends Node

# 运行时像素美术生成：无外部素材，全部用字符画 + 调色板生成 ImageTexture
# 项目渲染设置为 Nearest 纹理过滤，配 Camera2D zoom=3 呈现像素风

const PALETTE := {
	".": Color(0, 0, 0, 0),
	"k": Color(0.12, 0.10, 0.12),
	"x": Color(0.10, 0.10, 0.10),
	"s": Color(0.93, 0.72, 0.55),
	"h": Color(0.16, 0.12, 0.10),
	"r": Color(0.69, 0.22, 0.22),
	"d": Color(0.20, 0.20, 0.30),
	"b": Color(0.78, 0.62, 0.28),
	"w": Color(0.80, 0.82, 0.88),
	"e": Color(0.25, 0.60, 0.30),
	"e2": Color(0.16, 0.42, 0.22),
	"g": Color(0.50, 0.36, 0.78),
	"m": Color(0.96, 0.96, 0.96),
	"y": Color(0.96, 0.84, 0.28),
	"o": Color(1.00, 0.63, 0.26),
}


# ---------- 玩家 ----------

const PLAYER_IDLE: PackedStringArray = [
	"................",
	"................",
	".....hhhhhh.....",
	".....hhhhhh.....",
	".....ssssss.....",
	".....ssssss.....",
	".....rrrrrr.....",
	"....rrrrrrrr....",
	"....rrrrrrrr....",
	".....bbbbbb.....",
	".....dddddd.....",
	"....dd..dd......",
	"....dd..dd......",
	"................",
	"................",
	"................",
]

const PLAYER_RUN_1: PackedStringArray = [
	"................",
	"................",
	".....hhhhhh.....",
	".....hhhhhh.....",
	".....ssssss.....",
	".....ssssss.....",
	".....rrrrrr.....",
	"....rrrrrrrr....",
	"....rrrrrrrr....",
	".....bbbbbb.....",
	".....dddddd.....",
	"...dd.dd.dd.....",
	"................",
	"................",
	"................",
	"................",
]

const PLAYER_RUN_2: PackedStringArray = [
	"................",
	"................",
	".....hhhhhh.....",
	".....hhhhhh.....",
	".....ssssss.....",
	".....ssssss.....",
	".....rrrrrr.....",
	"....rrrrrrrr....",
	"....rrrrrrrr....",
	".....bbbbbb.....",
	".....dddddd.....",
	"....dddddd......",
	"....dd....dd....",
	"................",
	"................",
	"................",
]

const PLAYER_ATTACK: PackedStringArray = [
	"................",
	"................",
	".....hhhhhh..w..",
	".....hhhhhh.ww..",
	".....ssssssww...",
	".....ssssss.w...",
	".....rrrrrr..w..",
	"....rrrrrrrr.w..",
	"....rrrrrrrr.w..",
	".....bbbbbb.w...",
	".....dddddd.....",
	"....dd..dd......",
	"....dd..dd......",
	"................",
	"................",
	"................",
]

const PLAYER_HURT: PackedStringArray = [
	"................",
	"................",
	".....hhhhhh.....",
	".....hxxhhh.....",
	".....ssssss.....",
	".....ssssss.....",
	".....rrrrrr.....",
	"....rrrrrrrr....",
	"....rrrrrrrr....",
	".....bbbbbb.....",
	".....dddddd.....",
	"....dd..dd......",
	"....dd..dd......",
	"................",
	"................",
	"................",
]

const PLAYER_DIE: PackedStringArray = [
	"................",
	"................",
	"................",
	"................",
	"................",
	"................",
	"................",
	"..hhhhssssrrrr..",
	"..hhhhssssrrrr..",
	"..rrrrrrrrrbbb..",
	"..dddddddddd....",
	"..dd..dd........",
	"................",
	"................",
	"................",
	"................",
]

# ---------- 史莱姆（近战） ----------

const SLIME_WALK_1: PackedStringArray = [
	"............",
	"...eeeeee...",
	".eeeeeeeeee.",
	"eeeeeeeeeeee",
	"eeekeeeeekee",
	"eeeeeeeeeeee",
	".eeeeeeeeee.",
	"..eeeeeeee..",
]

const SLIME_WALK_2: PackedStringArray = [
	"............",
	"...eeeeee...",
	"..eeeeeeee..",
	".eeeeeeeeee.",
	"eeekeeeeekee",
	"eeeeeeeeeeee",
	".eeeeeeeeee.",
	"............",
]

const SLIME_ATTACK: PackedStringArray = [
	"............",
	"...eeeeee...",
	".eeeeeeeeeee",
	"eeeeeeeeeeeee",
	"eeekeeeeekeee",
	"eeeeeeeeeeeee",
	".eeeeeeeeeee",
	"............",
]

const SLIME_DIE: PackedStringArray = [
	"............",
	"............",
	"............",
	"............",
	"eeeeeeeeeeee",
	"eekeeeeekeee",
	"eeeeeeeeeeee",
	"............",
]

# ---------- 幽灵（远程） ----------

const GHOST_WALK_1: PackedStringArray = [
	"....kk....",
	"...kggk...",
	"..kggggk..",
	".kggggggk.",
	".kgmggmgk.",
	".kggggggk.",
	".kggggggk.",
	"..kggggk..",
	"...kggk...",
	"....kk....",
	"....kk....",
	"..kk..kk..",
	"............",
	"............",
]

const GHOST_WALK_2: PackedStringArray = [
	"....kk....",
	"...kggk...",
	"..kggggk..",
	".kggggggk.",
	".kgmggmgk.",
	".kggggggk.",
	"..kggggk..",
	"...kggggk.",
	"...kggggk.",
	"....kggk..",
	"....kggk..",
	"....kk....",
	"....kk....",
	"....kk....",
]

const GHOST_DIE: PackedStringArray = [
	"............",
	"............",
	"............",
	"............",
	"............",
	"...kggggk...",
	"..kggggggk..",
	".kggggggggk.",
	".kggggggggk.",
	".kgmggmgkgk.",
	".kggggggggk.",
	".kggggggggk.",
	"..kkkkkkkk..",
	"............",
]

# ---------- 掉落物 / 弹道 ----------

const ORB: PackedStringArray = [
	"...yyy..",
	"..yyyyy.",
	".yyyyyyy",
	"yyyyyyyy",
	".yyyyyyy",
	"..yyyyy.",
	"...yyy..",
]

const PROJECTILE: PackedStringArray = [
	"..oooo..",
	".oooooo.",
	".oooooo.",
	".oooooo.",
	"..oooo..",
]


func player_frames() -> SpriteFrames:
	var sf := SpriteFrames.new()
	sf.add_animation("idle")
	sf.add_frame("idle", _texture(PLAYER_IDLE))
	sf.set_animation_loop("idle", true)
	sf.add_animation("run")
	for frame in [PLAYER_RUN_1, PLAYER_RUN_2]:
		sf.add_frame("run", _texture(frame))
	sf.set_animation_speed("run", 8.0)
	sf.set_animation_loop("run", true)
	sf.add_animation("attack")
	sf.add_frame("attack", _texture(PLAYER_ATTACK))
	sf.add_animation("hurt")
	sf.add_frame("hurt", _texture(PLAYER_HURT))
	sf.add_animation("die")
	sf.add_frame("die", _texture(PLAYER_DIE))
	return sf


func slime_frames() -> SpriteFrames:
	var sf := SpriteFrames.new()
	sf.add_animation("walk")
	for frame in [SLIME_WALK_1, SLIME_WALK_2]:
		sf.add_frame("walk", _texture(frame))
	sf.set_animation_speed("walk", 6.0)
	sf.set_animation_loop("walk", true)
	sf.add_animation("attack")
	sf.add_frame("attack", _texture(SLIME_ATTACK))
	sf.add_animation("die")
	sf.add_frame("die", _texture(SLIME_DIE))
	return sf


func ghost_frames() -> SpriteFrames:
	var sf := SpriteFrames.new()
	sf.add_animation("walk")
	for frame in [GHOST_WALK_1, GHOST_WALK_2]:
		sf.add_frame("walk", _texture(frame))
	sf.set_animation_speed("walk", 6.0)
	sf.set_animation_loop("walk", true)
	sf.add_animation("die")
	sf.add_frame("die", _texture(GHOST_DIE))
	return sf


func orb_texture() -> ImageTexture:
	return _texture(ORB)


func projectile_texture() -> ImageTexture:
	return _texture(PROJECTILE)


func _texture(rows: PackedStringArray) -> ImageTexture:
	var height := rows.size()
	var width := 0
	for row in rows:
		width = maxi(width, row.length())
	var img := Image.create(width, height, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	for y in height:
		var row: String = rows[y]
		for x in row.length():
			img.set_pixel(x, y, PALETTE.get(row[x], Color(1.0, 0.0, 1.0, 1.0)))
	return ImageTexture.create_from_image(img)
