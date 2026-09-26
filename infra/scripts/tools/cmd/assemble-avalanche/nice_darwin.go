package main

import "syscall"

// lowerPriority is os.nice(n): raise this process's niceness by n.
func lowerPriority(n int) {
	cur, err := syscall.Getpriority(syscall.PRIO_PROCESS, 0)
	if err != nil {
		return
	}
	syscall.Setpriority(syscall.PRIO_PROCESS, 0, min(19, cur+n))
}
