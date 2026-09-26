package main

import "syscall"

// lowerPriority is os.nice(n): raise this process's niceness by n. Linux's getpriority
// system call returns 20 - nice, not the niceness itself.
func lowerPriority(n int) {
	raw, err := syscall.Getpriority(syscall.PRIO_PROCESS, 0)
	if err != nil {
		return
	}
	syscall.Setpriority(syscall.PRIO_PROCESS, 0, min(19, (20-raw)+n))
}
