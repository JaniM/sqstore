<script setup lang="ts">
import { useOperation } from "@next-gen-store/vue";
import { inject } from "vue";
import type { TodoStore } from "../store";
import type { Todo } from "../types";

const props = defineProps<{ todo: Todo }>();

const store = inject<TodoStore>("store")!;

const { execute: toggleTodo, isLoading: isToggling } = useOperation(store, "toggleTodo", {
  params: { id: props.todo.id },
});

const { execute: deleteTodo, isLoading: isDeleting } = useOperation(store, "deleteTodo", {
  params: { id: props.todo.id },
});
</script>

<template>
  <div class="todo-item">
    <input type="checkbox" :checked="todo.completed" :disabled="isToggling" @change="toggleTodo" />
    <span class="title" :class="{ completed: todo.completed }">
      {{ todo.title }}
    </span>
    <span v-if="isToggling || isDeleting" class="spinner"></span>
    <button v-else class="delete-btn" @click="deleteTodo">&times;</button>
  </div>
</template>
