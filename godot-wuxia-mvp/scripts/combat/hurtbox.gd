class_name Hurtbox
extends Area2D

# 受击判定框：被 Hitbox 覆盖时发出 hurt_received(damage)，
# 由所属角色（玩家/敌人）负责扣血 + 闪白

signal hurt_received(damage: int)


func _ready() -> void:
	area_entered.connect(_on_area_entered)


func _on_area_entered(area: Area2D) -> void:
	if area is Hitbox:
		hurt_received.emit(area.damage)
