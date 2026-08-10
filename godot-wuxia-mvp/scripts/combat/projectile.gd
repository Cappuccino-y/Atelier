class_name Projectile
extends Area2D

# 远程敌人弹道：直线飞行，命中玩家 Hurtbox 造成伤害

@export var speed := 220.0
@export var damage := 8
@export var lifetime := 3.0

var direction := Vector2.RIGHT

@onready var sprite: Sprite2D = $Sprite


func _ready() -> void:
	sprite.texture = PixelArt.projectile_texture()
	area_entered.connect(_on_area_entered)


func _physics_process(delta: float) -> void:
	position += direction * speed * delta
	lifetime -= delta
	if lifetime <= 0.0:
		queue_free()


func _on_area_entered(area: Area2D) -> void:
	if area is Hurtbox:
		area.hurt_received.emit(damage)
		queue_free()
