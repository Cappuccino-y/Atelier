extends Node2D

const MELEE_SCENE := preload("res://scenes/enemies/melee_enemy.tscn")
const RANGED_SCENE := preload("res://scenes/enemies/ranged_enemy.tscn")
const ORB_SCENE := preload("res://scenes/xp_orb.tscn")

const ARENA := Rect2(-560.0, -320.0, 1120.0, 640.0)

@onready var world: Node2D = $World
@onready var player: Player = $World/Player
@onready var hud: CanvasLayer = $HUD
@onready var level_up_ui: Control = $UI/LevelUpUI

var _game_over := false


func _ready() -> void:
	FX.camera = player.camera
	level_up_ui.setup(player)
	player.hp_changed.connect(hud.update_hp)
	player.xp_changed.connect(hud.update_xp)
	player.leveled_up.connect(_on_leveled_up)
	player.died.connect(_on_player_died)
	hud.update_hp(player.current_hp, player.get_max_hp())
	hud.update_xp(0, player.xp_to_next(), 1)

	_spawn_enemy(MELEE_SCENE, Vector2(ARENA.end.x - 40.0, 0.0))
	_spawn_enemy(RANGED_SCENE, Vector2(ARENA.position.x + 40.0, 40.0))


func _spawn_enemy(scene: PackedScene, pos: Vector2) -> void:
	var e: Enemy = scene.instantiate()
	e.global_position = pos
	e.died.connect(_on_enemy_died)
	world.add_child(e)


func _spawn_orb(pos: Vector2, xp: int) -> void:
	var orb := ORB_SCENE.instantiate()
	orb.global_position = pos
	orb.xp_amount = xp
	world.add_child(orb)


func _on_enemy_died(enemy: Enemy, xp: int) -> void:
	_spawn_orb(enemy.global_position, xp)
	if _game_over:
		return
	get_tree().create_timer(2.0).timeout.connect(_spawn_random_enemy)


func _spawn_random_enemy() -> void:
	if _game_over or is_queued_for_deletion():
		return
	var scene := MELEE_SCENE if randi() % 2 == 0 else RANGED_SCENE
	var pos := Vector2(
		randf_range(ARENA.position.x, ARENA.end.x),
		randf_range(ARENA.position.y, ARENA.end.y)
	)
	_spawn_enemy(scene, pos)


func _on_leveled_up(level: int) -> void:
	level_up_ui.show_choices(level)


func _on_player_died() -> void:
	_game_over = true
	hud.show_game_over()
	get_tree().paused = true
