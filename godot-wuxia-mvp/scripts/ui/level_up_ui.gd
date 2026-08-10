extends Control

# 升级三选一弹窗：攻/防/血，随机顺序。弹出时暂停游戏

@onready var title: Label = $Panel/VBox/Title
@onready var button_container: HBoxContainer = $Panel/VBox/Buttons

var _player: Player
var _choices: Array[Dictionary] = [
	{"label": "力量 +6 伤害", "kind": "atk"},
	{"label": "筋骨 +3 防御", "kind": "def"},
	{"label": "体魄 +20 生命", "kind": "hp"},
]


func setup(player: Player) -> void:
	_player = player


func show_choices(level: int) -> void:
	title.text = "升级！当前等级 %d" % level
	for child in button_container.get_children():
		child.queue_free()
	var shuffled := _choices.duplicate()
	shuffled.shuffle()
	for choice in shuffled:
		var btn := Button.new()
		btn.text = choice["label"]
		btn.custom_minimum_size = Vector2(220, 56)
		btn.pressed.connect(_on_choice.bind(choice["kind"]))
		button_container.add_child(btn)
	visible = true
	get_tree().paused = true


func _on_choice(kind: String) -> void:
	_player.apply_choice(kind)
	visible = false
	get_tree().paused = false
