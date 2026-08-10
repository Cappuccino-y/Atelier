class_name MeleeEnemy
extends Enemy

# 近战史莱姆：追踪玩家 → 近身蓄力 → 挥砍（攻击帧开 hitbox）

const ATTACK_RANGE := 42.0
const WINDUP_TIME := 0.25
const ATTACK_TIME := 0.15
const RECOVER_TIME := 0.6

enum Action { CHASE, WINDUP, ATTACKING, RECOVER }

var _action := Action.CHASE
var _windup_left := 0.0
var _attack_left := 0.0
var _recover_left := 0.0
var _facing := Vector2.LEFT

@onready var hitbox: Hitbox = $Hitbox


func _ready() -> void:
	super()
	hitbox.damage = touch_damage
	anim.sprite_frames = PixelArt.slime_frames()
	anim.play("walk")


func _physics_process(delta: float) -> void:
	var target := get_tree().get_first_node_in_group("player")
	match _action:
		Action.CHASE:
			if target == null:
				velocity = Vector2.ZERO
			else:
				var to_target: Vector2 = target.global_position - global_position
				_facing = to_target.normalized()
				_face(_facing)
				if to_target.length() < ATTACK_RANGE:
					_action = Action.WINDUP
					_windup_left = WINDUP_TIME
					velocity = Vector2.ZERO
				else:
					velocity = _facing * move_speed
					anim.play("walk")
			move_and_slide()
		Action.WINDUP:
			velocity = Vector2.ZERO
			_windup_left -= delta
			if _windup_left <= 0.0:
				_action = Action.ATTACKING
				_attack_left = ATTACK_TIME
				anim.play("attack")
				_swing()
		Action.ATTACKING:
			_attack_left -= delta
			if _attack_left <= 0.0:
				hitbox.set_deferred("monitoring", false)
				hitbox.set_deferred("monitorable", false)
				_action = Action.RECOVER
				_recover_left = RECOVER_TIME
		Action.RECOVER:
			velocity = Vector2.ZERO
			_recover_left -= delta
			if _recover_left <= 0.0:
				_action = Action.CHASE


func _swing() -> void:
	hitbox.global_position = global_position + _facing * 14.0
	hitbox.set_deferred("monitoring", true)
	hitbox.set_deferred("monitorable", true)
