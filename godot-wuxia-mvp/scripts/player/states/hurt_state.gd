class_name HurtState
extends BaseState

const DURATION := 0.25

var _timer := 0.0


func _enter() -> void:
	_timer = 0.0
	player.anim.play("hurt")
	player.velocity = Vector2.ZERO
	player.hitbox.set_deferred("monitoring", false)
	player.hitbox.set_deferred("monitorable", false)


func _physics_update(delta: float) -> void:
	_timer += delta
	if _timer >= DURATION:
		player.state_machine.transition_to("IdleState")
