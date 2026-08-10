extends CanvasLayer

@onready var hp_bar: ProgressBar = $TopBar/BarBox/HpBar
@onready var xp_bar: ProgressBar = $TopBar/BarBox/XpBar
@onready var level_label: Label = $TopBar/BarBox/LevelLabel
@onready var game_over_label: Label = $GameOverLabel

var _game_over := false


func update_hp(current: int, max_hp: int) -> void:
	hp_bar.max_value = max_hp
	hp_bar.value = current


func update_xp(current: int, needed: int, level: int) -> void:
	xp_bar.max_value = needed
	xp_bar.value = current
	level_label.text = "LV %d" % level


func show_game_over() -> void:
	_game_over = true
	game_over_label.visible = true


func _unhandled_input(event: InputEvent) -> void:
	if _game_over and event.is_action_pressed("restart"):
		get_tree().paused = false
		get_tree().reload_current_scene()
