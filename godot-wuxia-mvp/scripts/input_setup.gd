extends Node

# 输入注册：在代码里用 InputMap 注册，避免手写 project.godot 的 InputEvent 序列化

func _ready() -> void:
	_add_key("move_left", KEY_A, KEY_LEFT)
	_add_key("move_right", KEY_D, KEY_RIGHT)
	_add_key("move_up", KEY_W, KEY_UP)
	_add_key("move_down", KEY_S, KEY_DOWN)
	_add_key("attack", KEY_J, KEY_SPACE)
	_add_key("restart", KEY_R)


func _add_key(action: String, key: Key, alt: Key = KEY_NONE) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var ev := InputEventKey.new()
	ev.physical_keycode = key
	InputMap.action_add_event(action, ev)
	if alt != KEY_NONE:
		var ev2 := InputEventKey.new()
		ev2.physical_keycode = alt
		InputMap.action_add_event(action, ev2)
