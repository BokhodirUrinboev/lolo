namespace Demo;

public static class Paging
{
    public static int PageCount(int totalItems, int pageSize)
    {
        return totalItems / pageSize;
    }
}
