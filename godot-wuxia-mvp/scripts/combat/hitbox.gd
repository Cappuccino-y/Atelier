class_name Hitbox
extends Area2D

# 攻击判定框：攻击帧才开启（monitoring/monitorable）
# 命中 Hurtbox 时发出 hit_landed，供攻击方触发打击感

signal hit_landed(target: Area2D)

@export var damage := 10


func _ready() -> void:
	area_entered.connect(_on_area_entered)


func _on_area_entered(area: Area2D) -> void:
	if area is Hurtbox:
		hit_landed.emit(area)
