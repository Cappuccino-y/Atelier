class_name Player
extends CharacterBody2D

signal hp_changed(current_hp: int, max_hp: int)
signal xp_changed(current_xp: int, needed_xp: int, level: int)
signal leveled_up(level: int)
signal died

@export var move_speed := 220.0
@export var base_max_hp := 100
@export var base_damage := 25
@export var base_defense := 0
@export var xp_base := 8
@export var attack_duration := 0.28

var current_hp := 100
var level := 1
var current_xp := 0

var damage_bonus := 0
var defense_bonus := 0
var hp_bonus := 0

var attack_direction := Vector2.RIGHT

@onready var anim: AnimatedSprite2D = $Anim
@onready var camera: Camera2D = $Camera
@onready var hitbox: Hitbox = $Hitbox
@onready var hurtbox: Hurtbox = $Hurtbox
@onready var collision_shape: CollisionShape2D = $CollisionShape2D
@onready var state_machine: StateMachine = $StateMachine


func _ready() -> void:
	current_hp = base_max_hp
	add_to_group("player")
	anim.sprite_frames = PixelArt.player_frames()
	anim.play("idle")
	state_machine.init(self)
	hitbox.hit_landed.connect(_on_hit_landed)
	hurtbox.hurt_received.connect(_on_hurt_received)


func get_max_hp() -> int:
	return base_max_hp + hp_bonus


func get_damage() -> int:
	return base_damage + damage_bonus


func xp_to_next() -> int:
	# 幂函数 XP 曲线：XP = base * level^1.5
	return int(round(float(xp_base) * pow(float(level), 1.5)))


func add_xp(amount: int) -> void:
	current_xp += amount
	while current_xp >= xp_to_next():
		current_xp -= xp_to_next()
		level += 1
		leveled_up.emit(level)
	xp_changed.emit(current_xp, xp_to_next(), level)


func apply_choice(kind: String) -> void:
	match kind:
		"atk":
			damage_bonus += 6
		"def":
			defense_bonus += 3
		"hp":
			hp_bonus += 20
			current_hp = mini(current_hp + 20, get_max_hp())
	hp_changed.emit(current_hp, get_max_hp())


func take_damage(amount: int) -> void:
	if current_hp <= 0:
		return
	var dmg := maxi(1, amount - base_defense - defense_bonus)
	current_hp -= dmg
	hp_changed.emit(current_hp, get_max_hp())
	FX.flash_white(anim)
	if current_hp <= 0:
		state_machine.transition_to("DieState")
	elif not state_machine.current_state is HurtState:
		state_machine.transition_to("HurtState")


func _on_hit_landed(_target: Area2D) -> void:
	# 刀刀到肉：顿帧 + 屏幕震动
	FX.hit_stop(2)
	FX.shake(0.45)


func _on_hurt_received(damage: int) -> void:
	take_damage(damage)
