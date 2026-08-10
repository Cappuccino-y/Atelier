class_name IdleState
extends BaseState


func _enter() -> void:
	player.anim.play("idle")
	player.velocity = Vector2.ZERO


func _physics_update(_delta: float) -> void:
	if Input.is_action_just_pressed("attack"):
		player.state_machine.transition_to("AttackState")
		return
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	if dir != Vector2.ZERO:
		player.attack_direction = dir.normalized()
		player.state_machine.transition_to("RunState")
