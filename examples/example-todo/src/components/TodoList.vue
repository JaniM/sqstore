<script setup lang="ts">
import { useOperation, useSlot } from "@next-gen-store/vue";
import { inject } from "vue";
import type { TodoStore } from "../store";
import TodoItem from "./TodoItem.vue";

const store = inject<TodoStore>("store")!;

const todos = useSlot(store, "todos");
const { isLoading, isError, error } = useOperation(store, "fetchTodos", {
  immediate: true,
});
const { execute: clearCompleted } = useOperation(store, "clearCompleted");

const hasCompleted = () => todos.value.some((t) => t.completed);
</script>

<template>
  <div v-if="isLoading && todos.length === 0" class="loading-center">
    <span class="spinner"></span> Loading todos...
  </div>

  <div v-else-if="isError" class="error-message">
    Failed to load todos: {{ error?.message }}
  </div>

  <template v-else>
    <div class="todo-list" v-if="todos.length > 0">
      <TodoItem
        v-for="todo in todos"
        :key="todo.id"
        :todo="todo"
      />
      <div class="footer">
        <span>{{ todos.filter((t) => !t.completed).length }} remaining</span>
        <button v-if="hasCompleted()" @click="clearCompleted()">
          Clear completed
        </button>
      </div>
    </div>

    <div v-else class="empty-message">No todos yet. Add one above!</div>
  </template>
</template>
