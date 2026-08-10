class_name StateMachine
extends Node

# 状态机：按子节点名字做路由（IdleState/RunState/AttackState/HurtState/DieState）

signal state_changed(from_state: String, to_state: String)

var _states: Dictionary = {}
var current_state: BaseState
var current_name := ""


func init(p: Player) -> void:
	for child in get_children():
		if child is BaseState:
			_states[child.name] = child
			child.init(p)
	if _states.is_empty():
		return
	transition_to(_states.keys()[0])


func transition_to(state_name: String) -> void:
	if not _states.has(state_name) or current_name == state_name:
		return
	if current_state != null:
		current_state._exit()
	var prev := current_name
	current_state = _states[state_name]
	current_name = state_name
	current_state._enter()
	state_changed.emit(prev, state_name)


func _physics_process(delta: float) -> void:
	if current_state != null:
		current_state._physics_update(delta)
