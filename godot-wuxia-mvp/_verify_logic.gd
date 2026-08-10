extends SceneTree

var _t := 0.0
var _started := false

func _initialize() -> void:
	var err := change_scene_to_file("res://scenes/main.tscn")
	print("change_scene err=", err)
	_started = true

func _process(delta: float) -> bool:
	if not _started:
		return false
	_t += delta
	if _t < 1.2:
		return false
	var root_node := root.get_node("Main")
	var ui: Control = root_node.get_node("UI/LevelUpUI")
	var player = root_node.get_node("World/Player")
	print("player_is_set=", ui.get("_player") != null)
	ui.show_choices(2)
	print("paused_after_show=", root.paused, " visible=", ui.visible)
	var buttons = ui.get_node("Panel/VBox/Buttons")
	var btns := buttons.get_children()
	print("button_count=", btns.size())
	var before: int = player.damage_bonus
	for b in btns:
		if "力量" in b.text:
			b.pressed.emit()
			break
	print("damage_bonus before=", before, " after=", player.damage_bonus)
	print("paused_after_choice=", root.paused, " visible_after=", ui.visible)
	return true
