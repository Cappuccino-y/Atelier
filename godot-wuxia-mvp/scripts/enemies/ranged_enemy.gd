class_name RangedEnemy
extends Enemy

# 远程幽灵：保持距离 + 周期性发射弹道

const PROJECTILE := preload("res://scenes/projectile.tscn")

@export var shoot_range := 260.0
@export var keep_distance := 160.0
@export var shoot_cooldown := 2.0

var _cooldown := 1.0


func _ready() -> void:
	super()
	anim.sprite_frames = PixelArt.ghost_frames()
	anim.play("walk")


func _physics_process(delta: float) -> void:
	var target := get_tree().get_first_node_in_group("player")
	if target == null:
		return
	var to_target: Vector2 = target.global_position - global_position
	var dist := to_target.length()
	var dir := to_target.normalized()
	_face(dir)
	if dist > keep_distance and dist < shoot_range:
		velocity = dir * move_speed
	else:
		velocity = Vector2.ZERO
	move_and_slide()
	_cooldown -= delta
	if dist < shoot_range and _cooldown <= 0.0:
		_shoot(dir)
		_cooldown = shoot_cooldown


func _shoot(dir: Vector2) -> void:
	var p := PROJECTILE.instantiate()
	p.global_position = global_position + dir * 12.0
	p.direction = dir
	p.damage = touch_damage
	get_parent().add_child(p)
