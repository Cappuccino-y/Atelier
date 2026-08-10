extends Area2D

# 击杀掉落 XP：碰到玩家就加经验并消失

@export var xp_amount := 5

@onready var sprite: Sprite2D = $Sprite

var _pulse := 0.0


func _ready() -> void:
	sprite.texture = PixelArt.orb_texture()
	body_entered.connect(_on_body_entered)


func _process(delta: float) -> void:
	_pulse += delta * 4.0
	var s := 1.0 + sin(_pulse) * 0.15
	sprite.scale = Vector2(s, s)


func _on_body_entered(body: Node2D) -> void:
	if body is Player:
		body.add_xp(xp_amount)
		queue_free()
