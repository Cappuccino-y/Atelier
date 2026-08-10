class_name BaseState
extends Node

# 状态基类：组合式 FSM，每个状态一个脚本
# 子类需实现 _enter / _exit / _physics_update

var player: Player


func init(p: Player) -> void:
	player = p


func _enter() -> void:
	pass


func _exit() -> void:
	pass


func _physics_update(_delta: float) -> void:
	pass
