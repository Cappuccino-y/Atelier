class_name Enemy
extends CharacterBody2D

signal died(enemy: Enemy, xp_value: int)

@export var max_hp := 30
@export var move_speed := 90.0
@export var touch_damage := 8
@export var xp_value := 5

var current_hp: int

@onready var anim: AnimatedSprite2D = $Anim
@onready var hurtbox: Hurtbox = $Hurtbox
@onready var collision_shape: CollisionShape2D = $CollisionShape2D


func _ready() -> void:
	current_hp = max_hp
	hurtbox.hurt_received.connect(_on_hurt_received)


func _physics_process(_delta: float) -> void:
	pass


func _on_hurt_received(damage: int) -> void:
	if current_hp <= 0:
		return
	current_hp -= damage
	FX.flash_white(anim)
	if current_hp <= 0:
		die()


func die() -> void:
	set_physics_process(false)
	set_process(false)
	collision_shape.set_deferred("disabled", true)
	hurtbox.set_deferred("monitoring", false)
	hurtbox.set_deferred("monitorable", false)
	for child in get_children():
		if child is Hitbox:
			child.set_deferred("monitoring", false)
			child.set_deferred("monitorable", false)
	if anim.has_animation("die"):
		anim.play("die")
	died.emit(self, xp_value)
	var tw := create_tween()
	tw.tween_interval(0.5)
	tw.tween_callback(queue_free)


func _face(dir: Vector2) -> void:
	if dir.x != 0.0:
		anim.flip_h = dir.x < 0.0
