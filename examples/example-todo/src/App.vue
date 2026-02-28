<script setup lang="ts">
import { onUnmounted, provide } from "vue";
import AddTodo from "./components/AddTodo.vue";
import TodoList from "./components/TodoList.vue";
import { createTodoStore, type TodoStore } from "./store";

const store = createTodoStore();

provide<TodoStore>("store", store);

onUnmounted(() => {
  store.destroy();
});
</script>

<template>
  <div class="app">
    <h1>Todos</h1>
    <AddTodo />
    <TodoList />
  </div>
</template>
