class_name AttackState
extends BaseState

var _timer := 0.0


func _enter() -> void:
	_timer = 0.0
	player.anim.play("attack")
	player.velocity = Vector2.ZERO
	var dir := player.attack_direction
	if dir == Vector2.ZERO:
		dir = Vector2.LEFT if player.anim.flip_h else Vector2.RIGHT
	player.anim.flip_h = dir.x < 0.0
	player.hitbox.damage = player.get_damage()
	# 攻击帧才启用 hitbox，放在朝向的前方
	player.hitbox.global_position = player.global_position + dir * 20.0
	_enable_hitbox()


func _exit() -> void:
	_disable_hitbox()


func _physics_update(delta: float) -> void:
	_timer += delta
	if _timer >= player.attack_duration:
		player.state_machine.transition_to("IdleState")


func _enable_hitbox() -> void:
	player.hitbox.set_deferred("monitoring", true)
	player.hitbox.set_deferred("monitorable", true)


func _disable_hitbox() -> void:
	player.hitbox.set_deferred("monitoring", false)
	player.hitbox.set_deferred("monitorable", false)
