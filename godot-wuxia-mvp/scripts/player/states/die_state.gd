class_name DieState
extends BaseState


func _enter() -> void:
	player.anim.play("die")
	player.velocity = Vector2.ZERO
	player.set_physics_process(false)
	player.collision_shape.set_deferred("disabled", true)
	player.hitbox.set_deferred("monitoring", false)
	player.hitbox.set_deferred("monitorable", false)
	player.emit_signal("died")
