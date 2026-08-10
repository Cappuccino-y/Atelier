class_name RunState
extends BaseState


func _enter() -> void:
	player.anim.play("run")


func _physics_update(_delta: float) -> void:
	if Input.is_action_just_pressed("attack"):
		player.attack_direction = Input.get_vector("move_left", "move_right", "move_up", "move_down").normalized()
		player.state_machine.transition_to("AttackState")
		return
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	if dir == Vector2.ZERO:
		player.state_machine.transition_to("IdleState")
		return
	player.velocity = dir.normalized() * player.move_speed
	player.move_and_slide()
	if dir.x != 0.0:
		player.anim.flip_h = dir.x < 0.0
	player.attack_direction = dir.normalized()
